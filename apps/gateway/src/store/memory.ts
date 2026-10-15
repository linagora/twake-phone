import { clampLimit, isDeclined, isMissed, type HistoryEntry, type HistoryPage, type HistoryQuery, type ConferenceRecord, type ProviderRecord, type PushSaveResult, type PushSubscriptionRecord, type Store, type UserMapping, type UserPresenceRecord, type VapidKeysRecord } from './types.js'

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
    for (const [k, e] of this.history) if (e.tenantId === tenantId && e.userId === userId) (this.history.delete(k), n++)
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
    this.secrets.set(key(tenantId, userId), { secretEnc, rotatedAt: new Date().toISOString() })
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
    if (c) pin === null ? delete c.pin : (c.pin = pin)
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

  async close() {}
}
