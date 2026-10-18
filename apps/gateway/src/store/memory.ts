import type { OperatorCdr } from '@twake/telephony-types'
import { clampLimit, isDeclined, isMissed, type HistoryEntry, type HistoryNearQuery, type HistoryPage, type HistoryQuery, type OperatorCdrOutcome, type OperatorCdrRecord, type OperatorCdrStats, type ConferenceRecord, type AlertRecord, type AlertQuery, type DidRecord, type OutboundHand, type OutboundRecord, type OutboundRules, ALERT_DEDUP_MS, alertKey, type ProviderRecord, type StoredAlert, type PushSaveResult, type PushSubscriptionRecord, type Store, type TrunkRecord, type UserMapping, type UserPresenceRecord, type VapidKeysRecord, type ClaimedDelivery, type ErasedCall, type ErasedCallsKept, type WebhookAttemptResult, type WebhookClaimCaps, type WebhookClaimTime, allocateClaims, type WebhookDeliveryQuery, type WebhookLease, type WebhookSendQuota, type WebhookDeliveryRecord, type WebhookQueueOptions, type WebhookStateChange, type WebhookStateEvent, type WebhookSubscriptionRecord, WEBHOOK_STATE_ROLE } from './types.js'
import type { WebhookEventType } from '@twake/telephony-types'
import { randomBytes } from 'node:crypto'
import { EMPTY_OUTBOUND, outboundVersion, staleOutbound } from '../outbound.js'
import { e164Of } from '../e164.js'
import { RECONCILE_EARLY_MS, RECONCILE_LATE_MS, remoteOf } from '../reconcile.js'

const key = (...parts: string[]) => parts.join('\u0000')
/** Two JSON values alike, whatever the order of their keys (as PostgreSQL compares jsonb). */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v
const sameJson = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(JSON.parse(JSON.stringify(b))))
/** A change of hands of an extension or a range of direct numbers (second review 10b, n°3). */
interface NumberChange {
  tenantId: string
  kind: 'extension' | 'did'
  first: string
  last: string
  at: string
}
const inRange = (c: Pick<NumberChange, 'first' | 'last'>, n: string) => c.first.length === n.length && c.first <= n && n <= c.last
const overlaps = (a: Pick<NumberChange, 'first' | 'last'>, b: Pick<NumberChange, 'first' | 'last'>) => a.first.length === b.first.length && a.first <= b.last && b.first <= a.last
type MemoryDelivery = WebhookDeliveryRecord & { claim?: string; subjectUser?: string; eraseBody?: boolean }

export const matchesHistory = (e: HistoryEntry, q: HistoryQuery): boolean => {
  if (q.direction && e.direction !== q.direction) return false
  if (q.status === 'missed' && !isMissed(e)) return false
  if (q.status === 'declined' && !isDeclined(e)) return false
  if (q.status === 'answered' && !e.answered) return false
  if (q.status === 'failed' && e.state !== 'failed') return false
  if (q.number && !e.remoteNumber.includes(q.number)) return false
  if (q.from && e.startedAt < q.from) return false
  if (q.to && e.startedAt > q.to) return false
  if (q.before && e.startedAt >= q.before) return false
  return true
}

/** The order of historyNear: by start, call, then person. */
const nearOrder = (a: Pick<HistoryEntry, 'startedAt' | 'callId' | 'userId'>, b: Pick<HistoryEntry, 'startedAt' | 'callId' | 'userId'>) =>
  a.startedAt !== b.startedAt ? (a.startedAt < b.startedAt ? -1 : 1) : a.callId !== b.callId ? (a.callId < b.callId ? -1 : 1) : a.userId === b.userId ? 0 : a.userId < b.userId ? -1 : 1

/** In-memory store for tests and single-process development. Same contract as PgStore. */
export class MemoryStore implements Store {
  private providers: ProviderRecord[] = []
  private mappings = new Map<string, UserMapping>()
  private history = new Map<string, HistoryEntry>()
  private conferences = new Map<string, ConferenceRecord>()
  private secrets = new Map<string, { secretEnc: string; rotatedAt: string }>()
  private favorites = new Map<string, string[]>()
  private presences = new Map<string, UserPresenceRecord>()
  private pushSubscriptions = new Map<string, PushSubscriptionRecord>()
  private vapid: VapidKeysRecord | null = null
  private trunks: TrunkRecord[] = []
  private dids = new Map<string, DidRecord>()
  private outbound = new Map<string, OutboundRecord>()
  private alerts: StoredAlert[] = []
  private alertId = 0
  private webhooks: WebhookSubscriptionRecord[] = []
  private webhookDomains = new Map<string, string[]>()
  private deliveries: MemoryDelivery[] = []
  private webhookState = new Map<string, { state: string; since: string }>()
  private webhookSends = new Map<string, { subscriptionId: string; at: number }[]>()
  private leases = new Map<string, { holder: string; until: number; heard: number; writeFrom: number; writeUntil: number }>()
  /** When deliveries were last taken of each subscription (claimWebhookDeliveries). */
  private claimedAt = new Map<string, string>()
  /** The operator's records of calls (step 10b), and when each was read (ms). */
  private operatorCdrs = new Map<string, OperatorCdrRecord & { readAt: number }>()
  /** When each person last erased their history (review 10b, n°1), and their direct numbers then (second review, n°3). */
  private erasures = new Map<string, string>()
  private erasedNumbers = new Map<string, readonly string[]>()
  /** When erased entries were, without a number (second review, n°2); when numbers changed hands (n°3). */
  private erasedCallList: (ErasedCall & { tenantId: string })[] = []
  private numberChanges: NumberChange[] = []
  /** What the platform knows of its operator (review 10b, n°8), as JSON; the uses counted of each quota (ms). */
  private operatorState = new Map<string, string>()
  private operatorQuota = new Map<string, number[]>()

  constructor(private readonly now: () => number = Date.now) {}

  async listProviders() {
    return [...this.providers]
  }

  async upsertProvider(record: ProviderRecord) {
    const site = record.site ?? 'default'
    this.providers = this.providers.filter(p => !(p.tenantId === record.tenantId && (p.site ?? 'default') === site))
    this.providers.push({ ...record, site })
  }

  async getMappingByUser(tenantId: string, userId: string) {
    return this.mappings.get(key(tenantId, userId)) ?? null
  }

  async getMappingByExtension(tenantId: string, extension: string) {
    for (const m of this.mappings.values()) if (m.tenantId === tenantId && m.extension === extension) return m
    return null
  }

  async upsertMapping(mapping: UserMapping) {
    for (const m of this.mappings.values()) {
      if (m.tenantId === mapping.tenantId && m.extension === mapping.extension && m.userId !== mapping.userId) {
        throw new Error('extension already mapped to another user of this tenant')
      }
    }
    const before = this.mappings.get(key(mapping.tenantId, mapping.userId))
    if (before?.extension !== mapping.extension) {
      // The extension it had changes hands; the one it takes too, when someone held it lately.
      if (before) this.changed(mapping.tenantId, 'extension', before.extension, before.extension)
      if (this.numberChanges.some(c => c.tenantId === mapping.tenantId && c.kind === 'extension' && c.first === mapping.extension)) this.changed(mapping.tenantId, 'extension', mapping.extension, mapping.extension)
    }
    this.mappings.set(key(mapping.tenantId, mapping.userId), { source: 'manual', ...mapping })
  }

  private changed(tenantId: string, kind: NumberChange['kind'], first: string, last: string) {
    this.numberChanges.push({ tenantId, kind, first, last, at: new Date(this.now()).toISOString() })
  }

  async listMappings(tenantId: string) {
    return [...this.mappings.values()].filter(m => m.tenantId === tenantId).sort((a, b) => a.userId.localeCompare(b.userId)).map(m => ({ ...m }))
  }

  async deleteMapping(tenantId: string, userId: string, opts: { left?: boolean } = {}) {
    const before = this.mappings.get(key(tenantId, userId))
    if (before) this.changed(tenantId, 'extension', before.extension, before.extension)
    this.mappings.delete(key(tenantId, userId))
    // Their erasure goes with them once they left (third review 10b, n°3): neither who nor their numbers are kept.
    // Given another extension, it stays (fourth review n°2).
    if (opts.left) {
      this.erasures.delete(key(tenantId, userId))
      this.erasedNumbers.delete(key(tenantId, userId))
    }
    // What was told of their presence goes with them (it is kept otherwise, whatever its age).
    this.webhookState.delete(key(tenantId, `presence:${userId}`))
  }

  async addHistory(entry: HistoryEntry) {
    const k = key(entry.tenantId, entry.userId, entry.callId)
    if (!this.history.has(k)) this.history.set(k, entry)
  }

  async listHistory(tenantId: string, userId: string, query: HistoryQuery = {}): Promise<HistoryPage> {
    const limit = clampLimit(query.limit)
    const all = [...this.history.values()]
      .filter(e => e.tenantId === tenantId && e.userId === userId && matchesHistory(e, query))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    const items = all.slice(0, limit)
    return { items, ...(all.length > limit ? { next: items.at(-1)!.startedAt } : {}) }
  }

  async deleteHistory(tenantId: string, userId: string, numbers: readonly string[] = [], kept?: ErasedCallsKept) {
    const at = new Date(this.now()).toISOString()
    this.erasures.set(key(tenantId, userId), at)
    this.erasedNumbers.set(key(tenantId, userId), [...numbers])
    const entries = [...this.history.values()].filter(e => e.tenantId === tenantId && e.userId === userId)
    const calls = new Set(entries.map(e => e.callId))
    // Only as asked (third review 10b, n°3): an organisation with an operator, the entries a record read later may be of.
    if (kept)
      for (const e of entries)
        if (e.startedAt >= kept.since)
          this.erasedCallList.push({ tenantId, direction: e.direction, startedAt: e.startedAt, endedAt: e.endedAt ?? e.startedAt, ...(kept.keyOf ? { remoteKey: kept.keyOf(e164Of(e.remoteNumber)) } : {}) })
    const wanted = new Set(numbers)
    // One of their entries would take it (second review 10b, n°2): same way, same number, the window of matchCdrs.
    const taken = (r: OperatorCdrRecord) => {
      const remote = remoteOf(r)
      const start = Date.parse(r.startedAt)
      return (
        !!remote &&
        entries.some(e => e.direction === r.direction && e164Of(e.remoteNumber) === e164Of(remote) && start >= Date.parse(e.startedAt) - RECONCILE_EARLY_MS && start <= Date.parse(e.endedAt ?? e.startedAt) + RECONCILE_LATE_MS)
      )
    }
    // The operator's records of their calls keep no number of them (kept as read, never read again).
    for (const r of this.operatorCdrs.values()) {
      if (r.tenantId !== tenantId) continue
      const linked = r.userId === userId || (!!r.callId && calls.has(r.callId))
      const theirs = r.startedAt < at && ((!!r.calling && wanted.has(r.calling)) || (!!r.called && wanted.has(r.called)))
      const pending = !r.outcome && taken(r)
      if (!linked && !theirs && !pending) continue
      if (!r.outcome && (theirs || pending)) r.outcome = 'erased'
      delete r.calling
      delete r.called
    }
    let n = 0
    for (const [k, e] of this.history) {
      if (e.tenantId !== tenantId || e.userId !== userId) continue
      this.history.delete(k)
      n++
    }
    return n
  }

  async historyErasedAt(tenantId: string, userId: string) {
    return this.erasures.get(key(tenantId, userId))
  }

  async numbersErasedAt(tenantId: string, numbers: readonly string[]) {
    const out = new Map<string, string>()
    for (const [k, list] of this.erasedNumbers) {
      if (k.split('\u0000')[0] !== tenantId) continue
      const at = this.erasures.get(k)!
      for (const n of numbers) if (list.includes(n) && (out.get(n) ?? '') < at) out.set(n, at)
    }
    return out
  }

  async erasedCalls(tenantId: string, from: string, to: string) {
    return this.erasedCallList.filter(c => c.tenantId === tenantId && c.startedAt >= from && c.startedAt <= to).map(({ tenantId: _t, ...c }) => ({ ...c }))
  }

  async numberChangedAt(tenantId: string, extension: string, number: string) {
    let at: string | undefined
    for (const c of this.numberChanges) {
      if (c.tenantId !== tenantId) continue
      if (c.kind === 'extension' ? c.first === extension : inRange(c, number)) at = !at || c.at > at ? c.at : at
    }
    return at
  }

  async knownOperatorCdrs(tenantId: string, operator: string, ids: readonly string[]) {
    return ids.filter(id => this.operatorCdrs.has(key(tenantId, operator, id)))
  }

  async addOperatorCdrs(tenantId: string, operator: string, cdrs: readonly OperatorCdr[]) {
    for (const c of cdrs) {
      const k = key(tenantId, operator, c.id)
      if (!this.operatorCdrs.has(k)) this.operatorCdrs.set(k, { ...structuredClone(c), tenantId, operator, readAt: this.now() })
    }
  }

  async pendingOperatorCdrs(tenantId: string, operator: string, readBefore: string, limit: number) {
    const before = Date.parse(readBefore)
    return [...this.operatorCdrs.values()]
      .filter(r => r.tenantId === tenantId && r.operator === operator && !r.outcome && r.readAt < before)
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map(({ readAt: _at, ...r }) => ({ ...r }))
  }

  async historyNear(tenantId: string, q: HistoryNearQuery) {
    const remotes = q.remotes && new Set(q.remotes)
    return [...this.history.values()]
      .filter(
        e =>
          e.tenantId === tenantId &&
          e.direction === q.direction &&
          !e.operatorOnly &&
          (q.reconciled || !e.operatorCdr) &&
          (!q.userId || e.userId === q.userId) &&
          (!remotes || remotes.has(e164Of(e.remoteNumber))) &&
          e.startedAt >= q.from &&
          e.startedAt <= q.to &&
          (!q.after || nearOrder(e, q.after) > 0)
      )
      .sort(nearOrder)
      .slice(0, q.limit)
      .map(e => ({ ...e }))
  }

  async operatorForwardsNear(tenantId: string, operator: string, line: string, from: string, to: string) {
    return [...this.operatorCdrs.values()]
      .filter(r => r.tenantId === tenantId && r.operator === operator && r.line === line && r.forwarded && r.startedAt >= from && r.startedAt <= to)
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1))
      .map(({ readAt: _at, ...r }) => ({ ...r }))
  }

  async settleOperatorCdrs(tenantId: string, operator: string, outcomes: readonly OperatorCdrOutcome[]) {
    for (const o of outcomes) {
      const r = this.operatorCdrs.get(key(tenantId, operator, o.id))
      if (!r || r.outcome) continue
      // Never in the history of a person who erased it since the call (review 10b, n°1), whatever the caller said.
      const erased = o.outcome === 'orphan' && o.entry ? this.erasures.get(key(tenantId, o.entry.userId)) : undefined
      if (o.erase || o.outcome === 'erased' || (erased && erased >= o.entry!.startedAt)) {
        delete r.calling
        delete r.called
        if (o.outcome !== 'matched') {
          r.outcome = o.outcome === 'forwarded' || o.outcome === 'invalid' ? o.outcome : 'erased'
          continue
        }
      }
      if (o.outcome === 'matched' && o.callId) {
        const entries = [...this.history.values()].filter(e => e.tenantId === tenantId && e.callId === o.callId && !e.operatorCdr && !e.operatorOnly)
        if (!entries.length) {
          r.outcome = 'unmatched'
          continue
        }
        for (const e of entries) Object.assign(e, { operator, operatorCdr: o.id })
        Object.assign(r, { outcome: 'matched', callId: o.callId })
      } else if (o.outcome === 'orphan' && o.entry) {
        await this.addHistory({ ...o.entry, tenantId, operator, operatorCdr: o.id, operatorOnly: true })
        Object.assign(r, { outcome: 'orphan', callId: o.entry.callId, userId: o.entry.userId })
      } else r.outcome = o.outcome === 'forwarded' || o.outcome === 'invalid' ? o.outcome : 'unmatched'
    }
  }

  async operatorCdrStats(tenantId: string, operator: string, since: string): Promise<OperatorCdrStats> {
    const stats: OperatorCdrStats = { total: 0, matched: 0, orphan: 0, unmatchedInbound: 0, unmatchedOutbound: 0, forwarded: 0, pending: 0, invalid: 0, erased: 0 }
    for (const r of this.operatorCdrs.values()) {
      if (r.tenantId !== tenantId || r.operator !== operator || r.startedAt < since) continue
      stats.total++
      if (!r.outcome) stats.pending++
      else if (r.outcome === 'unmatched') stats[r.direction === 'inbound' ? 'unmatchedInbound' : 'unmatchedOutbound']++
      else stats[r.outcome]++
    }
    return stats
  }

  async purgeErasures(before: string) {
    const was = this.erasedCallList.length + this.numberChanges.length + this.erasures.size
    this.erasedCallList = this.erasedCallList.filter(c => c.startedAt >= before)
    this.numberChanges = this.numberChanges.filter(c => c.at >= before)
    for (const [k, at] of this.erasures)
      if (at < before) {
        this.erasures.delete(k)
        this.erasedNumbers.delete(k)
      }
    return was - (this.erasedCallList.length + this.numberChanges.length + this.erasures.size)
  }

  async purgeOperatorCdrs(before: string) {
    let n = 0
    for (const [k, r] of this.operatorCdrs) {
      if (r.startedAt >= before) continue
      this.operatorCdrs.delete(k)
      n++
    }
    return n
  }

  async getOperatorState(tenantId: string, k: string): Promise<unknown> {
    const v = this.operatorState.get(key(tenantId, k))
    return v === undefined ? undefined : JSON.parse(v)
  }

  async listOperatorState(tenantId: string, prefix: string) {
    return [...this.operatorState]
      .map(([k, v]) => ({ k: k.split('\u0000'), v }))
      .filter(({ k }) => k[0] === tenantId && k[1]!.startsWith(prefix))
      .map(({ k, v }) => ({ key: k[1]!, value: JSON.parse(v) as unknown }))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
  }

  async putOperatorState(tenantId: string, k: string, value: unknown) {
    this.operatorState.set(key(tenantId, k), JSON.stringify(value))
  }

  async deleteOperatorState(tenantId: string, k: string, ifValue?: unknown) {
    const v = this.operatorState.get(key(tenantId, k))
    if (v === undefined || (ifValue !== undefined && !sameJson(JSON.parse(v), ifValue))) return false
    return this.operatorState.delete(key(tenantId, k))
  }

  async takeOperatorQuota(tenantId: string, k: string, windowMs: number, max: number) {
    const t = this.now()
    const used = (this.operatorQuota.get(key(tenantId, k)) ?? []).filter(at => at > t - windowMs)
    const ok = used.length < max
    if (ok) used.push(t)
    this.operatorQuota.set(key(tenantId, k), used)
    return ok
  }

  async listFavorites(tenantId: string, userId: string) {
    return [...(this.favorites.get(key(tenantId, userId)) ?? [])]
  }

  async addFavorite(tenantId: string, userId: string, contactId: string) {
    const list = this.favorites.get(key(tenantId, userId)) ?? []
    if (!list.includes(contactId)) list.push(contactId)
    this.favorites.set(key(tenantId, userId), list)
  }

  async removeFavorite(tenantId: string, userId: string, contactId: string) {
    const k = key(tenantId, userId)
    this.favorites.set(k, (this.favorites.get(k) ?? []).filter(id => id !== contactId))
  }

  private live(r: UserPresenceRecord | undefined) {
    return r && !(r.until && Date.parse(r.until) <= this.now()) ? r : undefined
  }

  async getUserPresence(tenantId: string, userId: string) {
    const r = this.live(this.presences.get(key(tenantId, userId)))
    return r ? { ...r } : null
  }

  async setUserPresence(record: UserPresenceRecord) {
    this.presences.set(key(record.tenantId, record.userId), { ...record })
  }

  async deleteUserPresence(tenantId: string, userId: string) {
    this.presences.delete(key(tenantId, userId))
  }

  async listUserPresences(tenantId: string) {
    for (const [k, r] of this.presences) if (!this.live(r)) this.presences.delete(k)
    return [...this.presences.values()].filter(r => r.tenantId === tenantId).sort((a, b) => a.userId.localeCompare(b.userId)).map(r => ({ ...r }))
  }

  async getSipSecret(tenantId: string, userId: string) {
    return this.secrets.get(key(tenantId, userId)) ?? null
  }

  async setSipSecret(tenantId: string, userId: string, secretEnc: string) {
    this.secrets.set(key(tenantId, userId), { secretEnc, rotatedAt: new Date(this.now()).toISOString() })
  }

  async claimConference(record: ConferenceRecord) {
    const existing = this.conferences.get(record.meetingId)
    if (existing) return existing
    this.conferences.set(record.meetingId, { ...record })
    return record
  }

  async getConference(meetingId: string) {
    return this.conferences.get(meetingId) ?? null
  }

  async setConferencePin(meetingId: string, pin: string | null) {
    const c = this.conferences.get(meetingId)
    if (!c) return
    if (pin === null) delete c.pin
    else c.pin = pin
  }

  async replaceConferencePin(meetingId: string, from: string | null, to: string | null) {
    const c = this.conferences.get(meetingId)
    if (!c || (c.pin ?? null) !== from) return false
    if (to === null) delete c.pin
    else c.pin = to
    return true
  }

  async countConferences(tenantId: string, ownerUserId?: string) {
    return [...this.conferences.values()].filter(c => c.tenantId === tenantId && (ownerUserId === undefined || c.ownerUserId === ownerUserId)).length
  }

  async listConferences(tenantId: string, ownerUserId: string) {
    return [...this.conferences.values()]
      .filter(c => c.tenantId === tenantId && c.ownerUserId === ownerUserId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map(c => ({ ...c }))
  }

  async deleteConference(meetingId: string) {
    this.conferences.delete(meetingId)
  }

  async listPushSubscriptions(tenantId: string, userId: string) {
    return [...this.pushSubscriptions.values()].filter(r => r.tenantId === tenantId && r.userId === userId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)).map(r => ({ ...r }))
  }

  async listPushUsers(tenantId: string) {
    return [...new Set([...this.pushSubscriptions.values()].filter(r => r.tenantId === tenantId).map(r => r.userId))].sort()
  }

  async savePushSubscription(record: PushSubscriptionRecord): Promise<PushSaveResult> {
    const old = this.pushSubscriptions.get(record.endpoint)
    if (old && old.tenantId !== record.tenantId) return { outcome: 'refused' }
    if (old && old.userId === record.userId && old.p256dh === record.p256dh && old.auth === record.auth) return { outcome: 'unchanged' }
    this.pushSubscriptions.set(record.endpoint, { ...record })
    if (!old) return { outcome: 'added' }
    return old.userId === record.userId ? { outcome: 'updated' } : { outcome: 'moved', previousUserId: old.userId }
  }

  async deletePushSubscription(tenantId: string, userId: string, endpoint: string) {
    const r = this.pushSubscriptions.get(endpoint)
    if (!r || r.tenantId !== tenantId || r.userId !== userId) return false
    return this.pushSubscriptions.delete(endpoint)
  }

  async deletePushEndpoint(endpoint: string) {
    const r = this.pushSubscriptions.get(endpoint)
    if (!r) return null
    this.pushSubscriptions.delete(endpoint)
    return { tenantId: r.tenantId, userId: r.userId }
  }

  async getVapidKeys() {
    return this.vapid ? { ...this.vapid } : null
  }

  async initVapidKeys(keys: VapidKeysRecord) {
    this.vapid ??= { ...keys }
    return { ...this.vapid }
  }

  async listTrunks(tenantId: string) {
    return this.trunks.filter(t => t.tenantId === tenantId).map(t => structuredClone(t))
  }

  async upsertTrunk(record: TrunkRecord) {
    const i = this.trunks.findIndex(t => t.tenantId === record.tenantId && t.id === record.id)
    const copy = structuredClone(record)
    if (i >= 0) this.trunks[i] = copy
    else this.trunks.push(copy)
  }

  async upsertTrunks(records: TrunkRecord[]) {
    for (const r of records) await this.upsertTrunk(r)
  }

  async deleteTrunk(tenantId: string, id: string) {
    const before = this.trunks.length
    this.trunks = this.trunks.filter(t => !(t.tenantId === tenantId && t.id === id))
    for (const [k, d] of this.dids)
      if (d.tenantId === tenantId && d.trunkId === id) {
        this.changed(tenantId, 'did', d.first, d.last)
        this.dids.delete(k)
      }
    return this.trunks.length < before
  }

  async listDids(tenantId: string) {
    return [...this.dids.values()].filter(d => d.tenantId === tenantId).sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0)).map(d => ({ ...d }))
  }

  async upsertDid(record: DidRecord) {
    if (!this.trunks.some(t => t.tenantId === record.tenantId && t.id === record.trunkId)) throw new Error(`no trunk ${record.trunkId} in this tenant`)
    const before = this.dids.get(key(record.tenantId, record.id))
    const same = before && before.first === record.first && before.last === record.last && before.target === record.target && (before.suffixDigits ?? 0) === (record.suffixDigits ?? 0)
    if (!same) {
      // What it rang changes hands; the numbers it takes too, when they changed hands lately.
      if (before) this.changed(record.tenantId, 'did', before.first, before.last)
      if (this.numberChanges.some(c => c.tenantId === record.tenantId && c.kind === 'did' && overlaps(c, record))) this.changed(record.tenantId, 'did', record.first, record.last)
    }
    this.dids.set(key(record.tenantId, record.id), { ...record })
  }

  async deleteDid(tenantId: string, id: string) {
    const before = this.dids.get(key(tenantId, id))
    if (before) this.changed(tenantId, 'did', before.first, before.last)
    return this.dids.delete(key(tenantId, id))
  }

  async getOutbound(tenantId: string) {
    const r = this.outbound.get(tenantId)
    return r ? structuredClone(r) : null
  }

  /** One turn per tenant for its outbound rules, as PostgreSQL's advisory lock gives. */
  private outboundTurns = new Map<string, Promise<unknown>>()
  private inOutboundTurn<T>(tenantId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.outboundTurns.get(tenantId) ?? Promise.resolve()).then(run)
    const settled = next.catch(() => undefined)
    this.outboundTurns.set(tenantId, settled)
    void settled.then(() => {
      if (this.outboundTurns.get(tenantId) === settled) this.outboundTurns.delete(tenantId)
    })
    return next
  }

  async setOutbound(record: OutboundRecord, expected?: string, hand?: OutboundHand) {
    await this.inOutboundTurn(record.tenantId, async () => {
      const kept = this.outbound.get(record.tenantId)
      const before: OutboundRules = kept ? { policy: kept.policy, profiles: kept.profiles, assignments: kept.assignments } : EMPTY_OUTBOUND
      if (expected !== undefined && outboundVersion(before) !== expected) throw staleOutbound()
      if (hand) {
        const { tenantId: _t, ...rules } = record
        await hand(structuredClone(rules), false).catch(async (err: unknown) => {
          await hand(structuredClone(before), true).catch(() => undefined)
          throw err
        })
      }
      this.outbound.set(record.tenantId, structuredClone(record))
    })
  }

  async holdOutbound(tenantId: string, run: (kept: OutboundRules) => Promise<void>) {
    await this.inOutboundTurn(tenantId, async () => {
      const kept = this.outbound.get(tenantId)
      await run(kept ? structuredClone({ policy: kept.policy, profiles: kept.profiles, assignments: kept.assignments }) : EMPTY_OUTBOUND)
    })
  }

  async addAlert(record: AlertRecord) {
    const key = alertKey(record.alert)
    const since = new Date(Date.parse(record.at) - ALERT_DEDUP_MS).toISOString()
    const open = this.alerts.filter(a => a.tenantId === record.tenantId && alertKey(a.alert) === key && a.lastAt >= since && !a.acknowledgedAt).at(-1)
    if (open) {
      if (record.at > open.lastAt) open.lastAt = record.at
      open.count++
      open.alert = structuredClone(record.alert)
      return
    }
    this.alerts.push({ ...structuredClone(record), id: String(++this.alertId), lastAt: record.at, count: 1, first: structuredClone(record.alert) })
  }

  async listAlerts(tenantId: string, query: AlertQuery = {}) {
    // The latest repeated first, the newest opened among those of the same instant.
    const order = (a: StoredAlert, b: StoredAlert) => Date.parse(b.lastAt) - Date.parse(a.lastAt) || Number(b.id) - Number(a.id)
    const cursor = query.before ? ({ lastAt: query.before.lastAt, id: query.before.id } as StoredAlert) : undefined
    return this.alerts
      .filter(a => a.tenantId === tenantId && (!cursor || order(cursor, a) < 0) && (!query.kind || a.alert.kind === query.kind) && (!query.param || a.alert.param === query.param) && (!query.state || (query.state === 'open') === !a.acknowledgedAt))
      .sort(order)
      .slice(0, clampLimit(query.limit))
      .map(a => structuredClone(a))
  }

  async acknowledgeAlert(tenantId: string, id: string, by: string, at: string, seen: string, count: number) {
    const alert = this.alerts.find(a => a.tenantId === tenantId && a.id === id)
    if (!alert) return null
    if (!alert.acknowledgedAt && Date.parse(alert.lastAt) === Date.parse(seen) && alert.count === count) Object.assign(alert, { acknowledgedAt: at, acknowledgedBy: by })
    return structuredClone(alert)
  }

  async purgeAlerts(before: string) {
    const kept = this.alerts.filter(a => a.lastAt >= before)
    const purged = this.alerts.length - kept.length
    this.alerts = kept
    return purged
  }

  async listWebhookSubscriptions(tenantId: string) {
    return this.webhooks.filter(w => w.tenantId === tenantId).map(w => structuredClone(w))
  }

  async getWebhookSubscription(tenantId: string, id: string) {
    const w = this.webhooks.find(x => x.tenantId === tenantId && x.id === id)
    return w ? structuredClone(w) : null
  }

  async addWebhookSubscription(record: WebhookSubscriptionRecord, max: number) {
    if (this.webhooks.filter(w => w.tenantId === record.tenantId).length >= max) return false
    if (this.webhooks.some(w => w.id === record.id)) throw new Error('webhook subscription id taken')
    this.webhooks.push(structuredClone(record))
    return true
  }

  /** The time a write is dated on: the one given (tests), the store's clock otherwise. */
  private at(at?: string) {
    return at ?? new Date(this.now()).toISOString()
  }

  private fail(d: MemoryDelivery, error: string) {
    Object.assign(d, { status: 'failed', lastError: error })
    for (const k of ['nextAttemptAt', 'claim'] as const) delete d[k]
    if (d.eraseBody) d.body = ''
  }

  private failPending(subscriptionId: string) {
    for (const d of this.deliveries) if (d.subscriptionId === subscriptionId && d.status === 'pending') this.fail(d, 'disabled')
  }

  private afresh(w: WebhookSubscriptionRecord) {
    w.failures = 0
    for (const k of ['failingSince', 'pausedUntil', 'backlog', 'backlogAt'] as const) delete w[k]
  }

  async updateWebhookSubscription(record: WebhookSubscriptionRecord) {
    const w = this.webhooks.find(x => x.tenantId === record.tenantId && x.id === record.id)
    if (!w) return false
    const enabling = record.enabled && !w.enabled
    Object.assign(w, { url: record.url, events: [...record.events], enabled: record.enabled, updatedAt: record.updatedAt })
    if (record.description) w.description = record.description
    else delete w.description
    if (enabling) this.afresh(w)
    if (record.enabled) delete w.disabledReason
    if (!record.enabled) this.failPending(record.id)
    return true
  }

  async renewWebhookSecret(tenantId: string, id: string, secretEnc: string, keepPreviousUntil: string | null, at: string) {
    const w = this.webhooks.find(x => x.tenantId === tenantId && x.id === id)
    if (!w) return false
    if (keepPreviousUntil === null) for (const k of ['secretPrevEnc', 'secretPrevUntil'] as const) delete w[k]
    else Object.assign(w, { secretPrevEnc: w.secretEnc, secretPrevUntil: keepPreviousUntil })
    Object.assign(w, { secretEnc, updatedAt: at })
    return true
  }

  async pauseWebhookSubscription(tenantId: string, id: string, until: string | null) {
    const w = this.webhooks.find(x => x.tenantId === tenantId && x.id === id)
    if (!w) return
    if (until === null) delete w.pausedUntil
    else w.pausedUntil = until
  }

  async resumeWebhookSubscription(tenantId: string, id: string) {
    const w = this.webhooks.find(x => x.tenantId === tenantId && x.id === id)
    if (!w) return false
    this.afresh(w)
    return true
  }

  async disableFailingWebhookSubscription(tenantId: string, id: string, at: string) {
    const w = this.webhooks.find(x => x.tenantId === tenantId && x.id === id)
    if (!w?.enabled) return false
    Object.assign(w, { enabled: false, disabledReason: 'failing', updatedAt: at })
    this.failPending(id)
    return true
  }

  async deleteWebhookSubscription(tenantId: string, id: string) {
    const before = this.webhooks.length
    this.webhooks = this.webhooks.filter(w => !(w.tenantId === tenantId && w.id === id))
    if (this.webhooks.length === before) return false
    this.deliveries = this.deliveries.filter(d => d.subscriptionId !== id)
    this.claimedAt.delete(id)
    // Its sends are kept (a subscription deleted and made again counts the same).
    return true
  }

  /** Whether a test or a replay may be sent now under `quota`; what is older than the window goes first. */
  private sendAllowed(tenantId: string, subscriptionId: string, at: string | undefined, quota: WebhookSendQuota) {
    const t = Date.parse(this.at(at))
    const recent = (this.webhookSends.get(tenantId) ?? []).filter(x => x.at > t - quota.windowMs)
    this.webhookSends.set(tenantId, recent)
    return recent.filter(x => x.subscriptionId === subscriptionId).length < quota.perSubscription && (quota.perTenant === undefined || recent.length < quota.perTenant)
  }

  private countSend(tenantId: string, subscriptionId: string, at: string | undefined) {
    const recent = this.webhookSends.get(tenantId) ?? []
    recent.push({ subscriptionId, at: Date.parse(this.at(at)) })
    this.webhookSends.set(tenantId, recent)
  }

  async getWebhookDomains(tenantId: string) {
    return [...(this.webhookDomains.get(tenantId) ?? [])]
  }

  async setWebhookDomains(tenantId: string, domains: string[]) {
    this.webhookDomains.set(tenantId, [...domains])
  }

  private pendingOf(subscriptionId: string) {
    return this.deliveries.filter(d => d.subscriptionId === subscriptionId && d.status === 'pending').length
  }

  private record({ claim: _c, subjectUser: _s, eraseBody: _e, ...d }: MemoryDelivery): WebhookDeliveryRecord {
    return structuredClone(d)
  }

  private queue(tenantId: string, subscriptionId: string, eventId: string, eventType: string, body: string, at: string, options: WebhookQueueOptions = {}): WebhookDeliveryRecord | null {
    if (this.deliveries.some(d => d.subscriptionId === subscriptionId && d.eventId === eventId)) return null
    const full = options.maxPending !== undefined && this.pendingOf(subscriptionId) >= options.maxPending
    const d: MemoryDelivery = {
      tenantId,
      id: `dlv_${randomBytes(16).toString('hex')}`,
      subscriptionId,
      eventId,
      eventType,
      body,
      ...(full ? { status: 'failed', lastError: 'backlog' } : { status: 'pending', nextAttemptAt: at }),
      attempts: 0,
      createdAt: at,
      ...(options.subjectUser ? { subjectUser: options.subjectUser } : {})
    }
    this.deliveries.push(d)
    if (full) {
      const w = this.webhooks.find(x => x.id === subscriptionId)
      if (w) Object.assign(w, { backlog: (w.backlog ?? 0) + 1, backlogAt: at })
    }
    return this.record(d)
  }

  private queueEvent(tenantId: string, eventId: string, eventType: WebhookEventType, body: string, at: string, options?: WebhookQueueOptions) {
    let queued = 0
    const backlogged: string[] = []
    for (const w of this.webhooks)
      if (w.tenantId === tenantId && w.enabled && w.events.includes(eventType)) {
        const d = this.queue(tenantId, w.id, eventId, eventType, body, at, options)
        if (d?.status === 'pending') queued++
        else if (d) backlogged.push(w.id)
      }
    return { queued, backlogged }
  }

  async enqueueWebhookEvent(tenantId: string, eventId: string, eventType: WebhookEventType, body: string, at: string | undefined, options?: WebhookQueueOptions) {
    const { queued, backlogged } = this.queueEvent(tenantId, eventId, eventType, body, this.at(at), options)
    if (backlogged.length) options?.onBacklog?.(backlogged)
    return queued
  }

  async enqueueWebhookDelivery(tenantId: string, subscriptionId: string, eventId: string, eventType: string, body: string, at: string | undefined, maxPending?: number, quota?: WebhookSendQuota) {
    if (!this.webhooks.some(w => w.tenantId === tenantId && w.id === subscriptionId)) return null
    if (maxPending !== undefined && this.pendingOf(subscriptionId) >= maxPending) return 'full' as const
    if (quota && !this.sendAllowed(tenantId, subscriptionId, at, quota)) return 'rate' as const
    const queued = this.queue(tenantId, subscriptionId, eventId, eventType, body, this.at(at))
    if (queued && quota) this.countSend(tenantId, subscriptionId, at)
    return queued
  }

  async claimWebhookDeliveries(limit: number, caps: WebhookClaimCaps, at?: WebhookClaimTime) {
    if (limit <= 0) return []
    const claim = randomBytes(12).toString('hex')
    const now = this.at(at?.now)
    const t = Date.parse(now)
    const leaseUntil = at?.leaseUntil ?? new Date(t + (caps.leaseMs ?? 60_000)).toISOString()
    const due = (d: MemoryDelivery) => d.status === 'pending' && d.nextAttemptAt !== undefined && Date.parse(d.nextAttemptAt) <= t && d.attempts < caps.maxAttempts
    const byDue = (a: MemoryDelivery, b: MemoryDelivery) => Date.parse(a.nextAttemptAt!) - Date.parse(b.nextAttemptAt!) || (a.id < b.id ? -1 : 1)
    // The enabled subscriptions not paused that have one due, and how many up to perSubscription.
    const first = new Map<string, MemoryDelivery>()
    const count = new Map<string, number>()
    for (const d of this.deliveries.filter(due).sort(byDue)) {
      if (!first.has(d.subscriptionId)) first.set(d.subscriptionId, d)
      count.set(d.subscriptionId, Math.min(caps.perSubscription, (count.get(d.subscriptionId) ?? 0) + 1))
    }
    const ready = this.webhooks
      .filter(w => first.has(w.id) && w.enabled && !(w.pausedUntil && Date.parse(w.pausedUntil) > t))
      .map(w => ({ id: w.id, tenantId: w.tenantId, dueAt: first.get(w.id)!.nextAttemptAt!, dueCount: count.get(w.id)!, ...(this.claimedAt.has(w.id) ? { claimedAt: this.claimedAt.get(w.id)! } : {}) }))
    // What all Gateways hold: taken, its lease running.
    const held = new Map<string, { tenantId: string; subscriptionId: string; n: number }>()
    for (const d of this.deliveries)
      if (d.status === 'pending' && d.claim && Date.parse(d.nextAttemptAt!) > t) {
        const h = held.get(d.subscriptionId) ?? { tenantId: d.tenantId, subscriptionId: d.subscriptionId, n: 0 }
        h.n++
        held.set(d.subscriptionId, h)
      }
    const out: ClaimedDelivery[] = []
    for (const { subscriptionId, n } of allocateClaims(limit, caps, ready, [...held.values()])) {
      const w = this.webhooks.find(x => x.id === subscriptionId)!
      this.claimedAt.set(subscriptionId, now)
      const previous = w.secretPrevEnc && w.secretPrevUntil && Date.parse(w.secretPrevUntil) > t ? { secretPrevEnc: w.secretPrevEnc } : {}
      for (const d of this.deliveries.filter(x => x.subscriptionId === subscriptionId && due(x)).sort(byDue).slice(0, n)) {
        d.attempts++
        d.lastAttemptAt = now
        d.nextAttemptAt = leaseUntil
        d.claim = claim
        out.push({ ...this.record(d), url: w.url, secretEnc: w.secretEnc, ...previous, claim })
      }
    }
    return out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1))
  }

  async sweepWebhookDeliveries(maxAttempts: number, now?: string) {
    const t = Date.parse(this.at(now))
    let n = 0
    for (const d of this.deliveries)
      if (d.status === 'pending' && d.attempts >= maxAttempts && d.nextAttemptAt !== undefined && Date.parse(d.nextAttemptAt) <= t) {
        this.fail(d, 'abandoned')
        n++
      }
    return n
  }

  async completeWebhookDelivery(id: string, claim: string, result: WebhookAttemptResult) {
    const d = this.deliveries.find(x => x.id === id)
    if (!d || d.claim !== claim || d.status !== 'pending') return null
    const at = this.at(result.at)
    delete d.claim
    if (result.status !== undefined) d.lastStatus = result.status
    else delete d.lastStatus
    if (result.delivered) {
      d.status = 'delivered'
      d.deliveredAt = at
      delete d.lastError
      delete d.nextAttemptAt
      if (d.eraseBody) d.body = ''
    } else {
      d.lastError = result.error
      const retry = result.retryAt ?? (result.retryInMs !== undefined ? new Date(Date.parse(at) + result.retryInMs).toISOString() : undefined)
      if (retry) d.nextAttemptAt = retry
      else this.fail(d, result.error)
    }
    const w = this.webhooks.find(x => x.id === d.subscriptionId)
    if (!w) return { failures: 0, at }
    if (result.delivered) {
      w.failures = 0
      for (const k of ['failingSince', 'pausedUntil'] as const) delete w[k]
    } else {
      w.failures++
      w.failingSince ??= at
    }
    return { failures: w.failures, ...(w.failingSince ? { failingSince: w.failingSince } : {}), at }
  }

  async listWebhookDeliveries(tenantId: string, subscriptionId: string, query: WebhookDeliveryQuery = {}) {
    const order = (a: WebhookDeliveryRecord, b: WebhookDeliveryRecord) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0)
    const cursor = query.before ? ({ createdAt: query.before.createdAt, id: query.before.id } as WebhookDeliveryRecord) : undefined
    return this.deliveries
      .filter(d => d.tenantId === tenantId && d.subscriptionId === subscriptionId && (!cursor || order(cursor, d) < 0) && (!query.status || d.status === query.status))
      .sort(order)
      .slice(0, clampLimit(query.limit))
      .map(d => this.record(d))
  }

  async replayWebhookDelivery(tenantId: string, subscriptionId: string, id: string, at?: string, maxPending?: number, quota?: WebhookSendQuota) {
    const d = this.deliveries.find(x => x.tenantId === tenantId && x.subscriptionId === subscriptionId && x.id === id)
    // One its person asked to erase is not sent again (its body is gone).
    if (!d || d.eraseBody) return null
    if (d.status === 'pending') return 'pending' as const
    if (maxPending !== undefined && this.pendingOf(subscriptionId) >= maxPending) return 'full' as const
    if (quota && !this.sendAllowed(tenantId, subscriptionId, at, quota)) return 'rate' as const
    Object.assign(d, { status: 'pending', attempts: 0, nextAttemptAt: this.at(at) })
    for (const k of ['claim', 'lastError', 'lastStatus', 'deliveredAt'] as const) delete d[k]
    if (quota) this.countSend(tenantId, subscriptionId, at)
    return this.record(d)
  }

  async purgeWebhookDeliveries(before: string) {
    const kept = this.deliveries.filter(d => d.status === 'pending' || Date.parse(d.createdAt) >= Date.parse(before))
    const purged = this.deliveries.length - kept.length
    this.deliveries = kept
    for (const [k, s] of this.webhookState) if (s.state === 'removed' && Date.parse(s.since) < Date.parse(before)) this.webhookState.delete(k)
    return purged
  }

  async eraseWebhookSubject(tenantId: string, userId: string) {
    const mine = (d: MemoryDelivery) => d.tenantId === tenantId && d.subjectUser === userId
    const kept = this.deliveries.filter(d => !(mine(d) && d.status !== 'pending'))
    const erased = this.deliveries.length - kept.length
    this.deliveries = kept
    for (const d of kept) if (mine(d)) d.eraseBody = true
    this.webhookState.delete(key(tenantId, `presence:${userId}`))
    return erased
  }

  async setWebhookState(change: WebhookStateChange, event: WebhookStateEvent, options?: WebhookQueueOptions) {
    const lease = this.leases.get(WEBHOOK_STATE_ROLE)
    const now = this.now()
    if (!lease || lease.holder !== change.holder || lease.writeFrom > now || lease.writeUntil <= now) return null
    const k = key(change.tenantId, change.subject)
    const before = this.webhookState.get(k)
    if (change.known && !before) return null
    // On its own clock, later than what was told (as the database's, to the microsecond, never goes back).
    const at = change.at ?? new Date(Math.max(this.now(), before ? Date.parse(before.since) + 1 : 0)).toISOString()
    if (before && (before.state === change.state || Date.parse(before.since) >= Date.parse(at))) return null
    this.webhookState.set(k, { state: change.state, since: at })
    const e = event(before?.state, at)
    const { queued, backlogged } = e ? this.queueEvent(change.tenantId, e.id, e.type, e.body, at, { ...options, ...(e.subjectUser ? { subjectUser: e.subjectUser } : {}) }) : { queued: 0, backlogged: [] }
    if (backlogged.length) options?.onBacklog?.(backlogged)
    return { previous: before?.state, queued }
  }

  async takeWebhookLease(role: string, holder: string, ms: number, heard = 0): Promise<WebhookLease | null> {
    const now = this.now()
    const lease = this.leases.get(role)
    if (ms <= 0) {
      if (lease?.holder === holder) Object.assign(lease, { until: Math.min(lease.until, now), writeUntil: Math.min(lease.writeUntil, now) })
      return null
    }
    if (lease && lease.holder !== holder && lease.until > now && !(heard > lease.heard)) return null
    const margin = Math.floor(ms / 3)
    const writeFrom = !lease ? now : lease.holder === holder ? lease.writeFrom : Math.max(now, Math.min(lease.writeUntil, now) + margin)
    this.leases.set(role, { holder, until: now + ms, heard, writeFrom, writeUntil: now + ms - margin })
    return { writeFrom: new Date(writeFrom).toISOString() }
  }

  async listWebhookStates(tenantId: string, prefix: string) {
    const out: { subject: string; state: string }[] = []
    for (const [k, s] of this.webhookState) {
      const [t, subject] = k.split('\u0000')
      if (t === tenantId && subject!.startsWith(prefix)) out.push({ subject: subject!, state: s.state })
    }
    return out.sort((a, b) => (a.subject < b.subject ? -1 : 1))
  }

  async clock() {
    return new Date(this.now()).toISOString()
  }

  async close() {}
}
