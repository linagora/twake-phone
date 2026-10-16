import { clampLimit, isDeclined, isMissed, type HistoryEntry, type HistoryPage, type HistoryQuery, type ConferenceRecord, type AlertRecord, type AlertQuery, type DidRecord, type OutboundHand, type OutboundRecord, type OutboundRules, ALERT_DEDUP_MS, alertKey, type ProviderRecord, type StoredAlert, type PushSaveResult, type PushSubscriptionRecord, type Store, type TrunkRecord, type UserMapping, type UserPresenceRecord, type VapidKeysRecord } from './types.js'
import { EMPTY_OUTBOUND, outboundVersion, staleOutbound } from '../outbound.js'

const key = (...parts: string[]) => parts.join('\u0000')

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
    this.mappings.set(key(mapping.tenantId, mapping.userId), { source: 'manual', ...mapping })
  }

  async listMappings(tenantId: string) {
    return [...this.mappings.values()].filter(m => m.tenantId === tenantId).sort((a, b) => a.userId.localeCompare(b.userId)).map(m => ({ ...m }))
  }

  async deleteMapping(tenantId: string, userId: string) {
    this.mappings.delete(key(tenantId, userId))
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

  async deleteHistory(tenantId: string, userId: string) {
    let n = 0
    for (const [k, e] of this.history) {
      if (e.tenantId !== tenantId || e.userId !== userId) continue
      this.history.delete(k)
      n++
    }
    return n
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
    for (const [k, d] of this.dids) if (d.tenantId === tenantId && d.trunkId === id) this.dids.delete(k)
    return this.trunks.length < before
  }

  async listDids(tenantId: string) {
    return [...this.dids.values()].filter(d => d.tenantId === tenantId).sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0)).map(d => ({ ...d }))
  }

  async upsertDid(record: DidRecord) {
    if (!this.trunks.some(t => t.tenantId === record.tenantId && t.id === record.trunkId)) throw new Error(`no trunk ${record.trunkId} in this tenant`)
    this.dids.set(key(record.tenantId, record.id), { ...record })
  }

  async deleteDid(tenantId: string, id: string) {
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

  async close() {}
}
