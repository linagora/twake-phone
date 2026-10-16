import { randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { EMPTY_OUTBOUND, outboundVersion, staleOutbound } from '../outbound.js'
import { ALERT_DEDUP_MS, alertKey, clampLimit, type AlertQuery, type AlertRecord, type StoredAlert, type ConferenceRecord, type DidRecord, type OutboundHand, type OutboundRecord, type OutboundRules, type HistoryEntry, type HistoryPage, type HistoryQuery, type MappingSource, type ProviderRecord, type PushSaveResult, type PushSubscriptionRecord, type Store, type TrunkRecord, type UserMapping, type UserPresenceRecord, type VapidKeysRecord, type ClaimedDelivery, type WebhookAttemptResult, type WebhookClaimCaps, type WebhookClaimTime, allocateClaims, claimOrder, type WebhookDeliveryQuery, type WebhookLease, type WebhookSendQuota, type WebhookDeliveryRecord, type WebhookHealth, type WebhookQueueOptions, type WebhookStateChange, type WebhookStateEvent, type WebhookSubscriptionRecord, WEBHOOK_STATE_ROLE } from './types.js'
import type { WebhookEventType } from '@twake/telephony-types'

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url))

// The rows as the tables hold them (migrations/), as pg hands them: timestamptz as Date, NULL as null. `query<Row>`
// is a claim the compiler cannot check: the storage contract (contract.ts), run against PostgreSQL, is what checks it.
type Timestamp = Date | string
type ProviderRow = { tenant_id: string; site: string; type: string; config: unknown }
type MappingRow = { tenant_id: string; user_id: string; extension: string; display_name: string | null; department: string | null; source: MappingSource; synced_at: Timestamp | null }
type HistoryRow = { tenant_id: string; user_id: string; call_id: string; direction: HistoryEntry['direction']; remote_number: string; started_at: Timestamp; ended_at: Timestamp | null; duration_sec: number; state: HistoryEntry['state']; answered: boolean; conference: boolean }
type PresenceRow = { tenant_id: string; user_id: string; status: UserPresenceRecord['status']; since: Timestamp; until: Timestamp | null; message: string | null }
type ConferenceRow = { tenant_id: string; meeting_id: string; owner_user_id: string; pin: string | null; created_at: Timestamp }
type PushRow = { tenant_id: string; user_id: string; endpoint: string; p256dh: string; auth: string; created_at: Timestamp }
type TrunkRow = { tenant_id: string; id: string; config: TrunkRecord['config']; password_enc: string | null }
type DidRow = { tenant_id: string; id: string; trunk_id: string; first_number: string; last_number: string; target: string | null; suffix_digits: number; fallback_target: string | null }
type OutboundRow = { tenant_id: string; policy: OutboundRecord['policy']; profiles: OutboundRecord['profiles']; assignments: OutboundRecord['assignments'] }
type AlertRow = { id: string; tenant_id: string; at: Timestamp; last_at: Timestamp; count: number; alert: AlertRecord['alert']; first_alert: AlertRecord['alert'] | null; acknowledged_at: Timestamp | null; acknowledged_by: string | null }
const ALERT_COLUMNS = 'id::text AS id, tenant_id, at, last_at, count, alert, first_alert, acknowledged_at, acknowledged_by'
const alertOf = (r: AlertRow): StoredAlert => ({
  id: r.id,
  tenantId: r.tenant_id,
  at: new Date(r.at).toISOString(),
  lastAt: new Date(r.last_at).toISOString(),
  count: r.count,
  alert: r.alert,
  first: r.first_alert ?? r.alert,
  ...(r.acknowledged_at ? { acknowledgedAt: new Date(r.acknowledged_at).toISOString() } : {}),
  ...(r.acknowledged_by ? { acknowledgedBy: r.acknowledged_by } : {})
})

type WebhookRow = {
  id: string
  tenant_id: string
  url: string
  events: WebhookEventType[]
  description: string | null
  enabled: boolean
  disabled_reason: string | null
  secret_enc: string
  secret_prev_enc: string | null
  secret_prev_until: Timestamp | null
  failures: number
  failing_since: Timestamp | null
  paused_until: Timestamp | null
  backlog: number
  backlog_at: Timestamp | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}
const webhookOf = (r: WebhookRow): WebhookSubscriptionRecord => ({
  tenantId: r.tenant_id,
  id: r.id,
  url: r.url,
  events: r.events,
  ...(r.description !== null ? { description: r.description } : {}),
  enabled: r.enabled,
  ...(r.disabled_reason === 'failing' ? { disabledReason: 'failing' as const } : {}),
  secretEnc: r.secret_enc,
  ...(r.secret_prev_enc !== null ? { secretPrevEnc: r.secret_prev_enc } : {}),
  ...(r.secret_prev_until !== null ? { secretPrevUntil: new Date(r.secret_prev_until).toISOString() } : {}),
  failures: r.failures,
  ...(r.failing_since !== null ? { failingSince: new Date(r.failing_since).toISOString() } : {}),
  ...(r.paused_until !== null ? { pausedUntil: new Date(r.paused_until).toISOString() } : {}),
  ...(r.backlog ? { backlog: r.backlog } : {}),
  ...(r.backlog_at !== null ? { backlogAt: new Date(r.backlog_at).toISOString() } : {}),
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
  ...(r.created_by !== null ? { createdBy: r.created_by } : {})
})
type DeliveryRow = {
  id: string
  tenant_id: string
  subscription_id: string
  event_id: string
  event_type: string
  body: string
  status: WebhookDeliveryRecord['status']
  attempts: number
  created_at: Timestamp
  next_attempt_at: Timestamp | null
  last_attempt_at: Timestamp | null
  last_status: number | null
  last_error: string | null
  delivered_at: Timestamp | null
}
const DELIVERY_COLUMNS = 'id, tenant_id, subscription_id, event_id, event_type, body, status, attempts, created_at, next_attempt_at, last_attempt_at, last_status, last_error, delivered_at'
const iso = (t: Timestamp) => new Date(t).toISOString()
const deliveryOf = (r: DeliveryRow): WebhookDeliveryRecord => ({
  tenantId: r.tenant_id,
  id: r.id,
  subscriptionId: r.subscription_id,
  eventId: r.event_id,
  eventType: r.event_type,
  body: r.body,
  status: r.status,
  attempts: r.attempts,
  createdAt: iso(r.created_at),
  ...(r.next_attempt_at ? { nextAttemptAt: iso(r.next_attempt_at) } : {}),
  ...(r.last_attempt_at ? { lastAttemptAt: iso(r.last_attempt_at) } : {}),
  ...(r.last_status !== null ? { lastStatus: r.last_status } : {}),
  ...(r.last_error !== null ? { lastError: r.last_error } : {}),
  ...(r.delivered_at ? { deliveredAt: iso(r.delivered_at) } : {})
})
/** A new delivery's id, drawn by PostgreSQL (gen_random_uuid, PostgreSQL 13 and later). */
const NEW_DELIVERY_ID = "'dlv_' || replace(gen_random_uuid()::text, '-', '')"
/** Deliveries removed per statement by the purge. */
const PURGE_BATCH = 5_000

const toEntry = (r: HistoryRow): HistoryEntry => ({
  tenantId: r.tenant_id,
  userId: r.user_id,
  callId: r.call_id,
  direction: r.direction,
  remoteNumber: r.remote_number,
  startedAt: new Date(r.started_at).toISOString(),
  ...(r.ended_at ? { endedAt: new Date(r.ended_at).toISOString() } : {}),
  durationSec: r.duration_sec,
  state: r.state,
  answered: r.answered,
  ...(r.conference ? { conference: true } : {})
})

/** A deadlock's victim (40P01) or a serialization failure (40001): rolled back whole, safe to run again. */
const retryable = (err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code
  return code === '40P01' || code === '40001'
}

/** PostgreSQL store. Every statement is parameterised and carries the tenant. */
export class PgStore implements Store {
  private readonly pool: pg.Pool
  /** The lease of the webhook states and the clock, on a connection of their own (never behind a rush of writes). */
  private readonly leasePool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 })
    this.leasePool = new pg.Pool({ connectionString, max: 1 })
  }

  /**
   * Applies the SQL files of migrations/ not yet applied, in order, each in a transaction: one Gateway at a time (two
   * started at once, the second waits, then finds them applied). The wait is said every `waitLogMs` (a Gateway stuck
   * in a migration holds the others): `log` (console.warn by default).
   */
  async migrate(options: { waitLogMs?: number; pollMs?: number; log?: (message: string) => void } = {}) {
    const client = await this.pool.connect()
    let failure: unknown
    let locked = false
    try {
      const started = Date.now()
      let said = started
      for (;;) {
        const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('schema_migrations', 0)) AS ok")
        if (rows[0]?.ok) break
        if (Date.now() - said >= (options.waitLogMs ?? 10_000)) {
          said = Date.now()
          ;(options.log ?? console.warn)(`database migrations: waiting for another Gateway that applies them (${Math.round((said - started) / 1000)} s)`)
        }
        await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 250))
      }
      locked = true
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
      const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(r => r.name))
      for (const file of (await readdir(MIGRATIONS)).filter(f => f.endsWith('.sql')).sort()) {
        if (done.has(file)) continue
        try {
          await client.query('BEGIN')
          await client.query(await readFile(MIGRATIONS + file, 'utf8'))
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw Object.assign(error as Error, { migration: file })
        }
      }
    } catch (err) {
      failure = err
      throw err
    } finally {
      // The lock goes with the session too: a client released broken (destroyed) gives it back. An unlock that fails
      // never hides why the migration did.
      if (locked && !failure) await client.query("SELECT pg_advisory_unlock(hashtextextended('schema_migrations', 0))").catch((err: unknown) => (failure = err))
      client.release(failure !== undefined)
    }
  }

  async listProviders(): Promise<ProviderRecord[]> {
    const { rows } = await this.pool.query<ProviderRow>('SELECT tenant_id, site, type, config FROM provider_configs ORDER BY id')
    return rows.map(r => ({ tenantId: r.tenant_id, site: r.site, type: r.type, config: r.config }))
  }

  async upsertProvider(r: ProviderRecord) {
    await this.pool.query(
      `INSERT INTO provider_configs (tenant_id, site, type, config) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, site) DO UPDATE SET type = EXCLUDED.type, config = EXCLUDED.config`,
      [r.tenantId, r.site ?? 'default', r.type, JSON.stringify(r.config)]
    )
  }

  private mapping(r: MappingRow | undefined): UserMapping | null {
    if (!r) return null
    return {
      tenantId: r.tenant_id,
      userId: r.user_id,
      extension: r.extension,
      ...(r.display_name ? { displayName: r.display_name } : {}),
      ...(r.department ? { department: r.department } : {}),
      source: r.source,
      ...(r.synced_at ? { syncedAt: new Date(r.synced_at).toISOString() } : {})
    }
  }

  async getMappingByUser(tenantId: string, userId: string) {
    const { rows } = await this.pool.query<MappingRow>('SELECT * FROM user_mappings WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
    return this.mapping(rows[0])
  }

  async getMappingByExtension(tenantId: string, extension: string) {
    const { rows } = await this.pool.query<MappingRow>('SELECT * FROM user_mappings WHERE tenant_id = $1 AND extension = $2', [tenantId, extension])
    return this.mapping(rows[0])
  }

  async upsertMapping(m: UserMapping) {
    await this.pool.query(
      `INSERT INTO user_mappings (tenant_id, user_id, extension, display_name, department, source, synced_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET extension = EXCLUDED.extension, display_name = EXCLUDED.display_name,
         department = EXCLUDED.department, source = EXCLUDED.source, synced_at = EXCLUDED.synced_at`,
      [m.tenantId, m.userId, m.extension, m.displayName ?? null, m.department ?? null, m.source ?? 'manual', m.syncedAt ?? null]
    )
  }

  async listMappings(tenantId: string) {
    const { rows } = await this.pool.query<MappingRow>('SELECT * FROM user_mappings WHERE tenant_id = $1 ORDER BY user_id', [tenantId])
    return rows.map(r => this.mapping(r)!)
  }

  async deleteMapping(tenantId: string, userId: string) {
    // What was told of their presence goes with them (it is kept otherwise, whatever its age).
    await this.inTransaction(async client => {
      await client.query('DELETE FROM user_mappings WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
      await client.query('DELETE FROM webhook_state WHERE tenant_id = $1 AND subject = $2', [tenantId, `presence:${userId}`])
    })
  }

  async addHistory(e: HistoryEntry) {
    await this.pool.query(
      `INSERT INTO call_history (tenant_id, user_id, call_id, direction, remote_number, started_at, ended_at, duration_sec, state, answered, conference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
      [e.tenantId, e.userId, e.callId, e.direction, e.remoteNumber, e.startedAt, e.endedAt ?? null, e.durationSec, e.state, e.answered, e.conference === true]
    )
  }

  async listHistory(tenantId: string, userId: string, q: HistoryQuery = {}): Promise<HistoryPage> {
    const limit = clampLimit(q.limit)
    const where = ['tenant_id = $1', 'user_id = $2']
    const args: unknown[] = [tenantId, userId]
    const add = (sql: string, value: unknown) => {
      args.push(value)
      where.push(sql.replace('?', `$${args.length}`))
    }
    if (q.direction) add('direction = ?', q.direction)
    if (q.status === 'missed') where.push("direction = 'inbound' AND answered = false AND state = 'missed'")
    if (q.status === 'declined') where.push("direction = 'inbound' AND answered = false AND state = 'rejected'")
    if (q.status === 'answered') where.push('answered = true')
    if (q.status === 'failed') where.push("state = 'failed'")
    if (q.number) add("remote_number LIKE '%' || ? || '%'", q.number.replace(/[\\%_]/g, c => `\\${c}`))
    if (q.from) add('started_at >= ?', q.from)
    if (q.to) add('started_at <= ?', q.to)
    if (q.before) add('started_at < ?', q.before)
    args.push(limit + 1)
    const { rows } = await this.pool.query<HistoryRow>(`SELECT * FROM call_history WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT $${args.length}`, args)
    const items = rows.slice(0, limit).map(toEntry)
    return { items, ...(rows.length > limit ? { next: items.at(-1)!.startedAt } : {}) }
  }

  async deleteHistory(tenantId: string, userId: string) {
    const r = await this.pool.query('DELETE FROM call_history WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
    return r.rowCount ?? 0
  }

  async listFavorites(tenantId: string, userId: string) {
    const { rows } = await this.pool.query<{ contact_id: string }>('SELECT contact_id FROM favorites WHERE tenant_id = $1 AND user_id = $2 ORDER BY added_at, contact_id', [tenantId, userId])
    return rows.map(r => r.contact_id)
  }

  async addFavorite(tenantId: string, userId: string, contactId: string) {
    await this.pool.query('INSERT INTO favorites (tenant_id, user_id, contact_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [tenantId, userId, contactId])
  }

  async removeFavorite(tenantId: string, userId: string, contactId: string) {
    await this.pool.query('DELETE FROM favorites WHERE tenant_id = $1 AND user_id = $2 AND contact_id = $3', [tenantId, userId, contactId])
  }

  private presence(r: PresenceRow): UserPresenceRecord {
    return {
      tenantId: r.tenant_id,
      userId: r.user_id,
      status: r.status,
      since: new Date(r.since).toISOString(),
      ...(r.until ? { until: new Date(r.until).toISOString() } : {}),
      ...(r.message ? { message: r.message } : {})
    }
  }

  async getUserPresence(tenantId: string, userId: string) {
    const { rows } = await this.pool.query<PresenceRow>('SELECT * FROM user_presence WHERE tenant_id = $1 AND user_id = $2 AND (until IS NULL OR until > now())', [tenantId, userId])
    return rows[0] ? this.presence(rows[0]) : null
  }

  async setUserPresence(p: UserPresenceRecord) {
    await this.pool.query(
      `INSERT INTO user_presence (tenant_id, user_id, status, since, until, message) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = EXCLUDED.status, since = EXCLUDED.since, until = EXCLUDED.until, message = EXCLUDED.message`,
      [p.tenantId, p.userId, p.status, p.since, p.until ?? null, p.message ?? null]
    )
  }

  async deleteUserPresence(tenantId: string, userId: string) {
    await this.pool.query('DELETE FROM user_presence WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
  }

  async listUserPresences(tenantId: string) {
    await this.pool.query('DELETE FROM user_presence WHERE until <= now()')
    const { rows } = await this.pool.query<PresenceRow>('SELECT * FROM user_presence WHERE tenant_id = $1 AND (until IS NULL OR until > now()) ORDER BY user_id', [tenantId])
    return rows.map(r => this.presence(r))
  }

  async getSipSecret(tenantId: string, userId: string) {
    const { rows } = await this.pool.query<{ secret_enc: string; rotated_at: Timestamp }>('SELECT secret_enc, rotated_at FROM sip_credentials WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
    return rows[0] ? { secretEnc: rows[0].secret_enc, rotatedAt: new Date(rows[0].rotated_at).toISOString() } : null
  }

  async setSipSecret(tenantId: string, userId: string, secretEnc: string) {
    await this.pool.query(
      `INSERT INTO sip_credentials (tenant_id, user_id, secret_enc) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, rotated_at = now()`,
      [tenantId, userId, secretEnc]
    )
  }

  private conference(r: ConferenceRow | undefined): ConferenceRecord | null {
    return r
      ? { tenantId: r.tenant_id, meetingId: r.meeting_id, ownerUserId: r.owner_user_id, ...(r.pin ? { pin: r.pin } : {}), createdAt: new Date(r.created_at).toISOString() }
      : null
  }

  async claimConference(c: ConferenceRecord) {
    await this.pool.query(
      'INSERT INTO conferences (meeting_id, tenant_id, owner_user_id, pin, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (meeting_id) DO NOTHING',
      [c.meetingId, c.tenantId, c.ownerUserId, c.pin ?? null, c.createdAt]
    )
    return (await this.getConference(c.meetingId))!
  }

  async getConference(meetingId: string) {
    const { rows } = await this.pool.query<ConferenceRow>('SELECT * FROM conferences WHERE meeting_id = $1', [meetingId])
    return this.conference(rows[0])
  }

  async setConferencePin(meetingId: string, pin: string | null) {
    await this.pool.query('UPDATE conferences SET pin = $2 WHERE meeting_id = $1', [meetingId, pin])
  }

  async replaceConferencePin(meetingId: string, from: string | null, to: string | null) {
    const { rowCount } = await this.pool.query('UPDATE conferences SET pin = $3 WHERE meeting_id = $1 AND pin IS NOT DISTINCT FROM $2', [meetingId, from, to])
    return (rowCount ?? 0) > 0
  }

  async countConferences(tenantId: string, ownerUserId?: string) {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM conferences WHERE tenant_id = $1 AND ($2::text IS NULL OR owner_user_id = $2)',
      [tenantId, ownerUserId ?? null]
    )
    return Number(rows[0]?.n ?? 0)
  }

  async listConferences(tenantId: string, ownerUserId: string) {
    const { rows } = await this.pool.query<ConferenceRow>('SELECT * FROM conferences WHERE tenant_id = $1 AND owner_user_id = $2 ORDER BY created_at, meeting_id', [tenantId, ownerUserId])
    return rows.map(r => this.conference(r)!)
  }

  async deleteConference(meetingId: string) {
    await this.pool.query('DELETE FROM conferences WHERE meeting_id = $1', [meetingId])
  }

  private pushSubscription(r: PushRow): PushSubscriptionRecord {
    return { tenantId: r.tenant_id, userId: r.user_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, createdAt: new Date(r.created_at).toISOString() }
  }

  async listPushSubscriptions(tenantId: string, userId: string) {
    const { rows } = await this.pool.query<PushRow>('SELECT * FROM push_subscriptions WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at, endpoint', [tenantId, userId])
    return rows.map(r => this.pushSubscription(r))
  }

  async listPushUsers(tenantId: string) {
    const { rows } = await this.pool.query<{ user_id: string }>('SELECT DISTINCT user_id FROM push_subscriptions WHERE tenant_id = $1 ORDER BY user_id', [tenantId])
    return rows.map(r => r.user_id)
  }

  async savePushSubscription(s: PushSubscriptionRecord): Promise<PushSaveResult> {
    // One statement: the row as it was (the snapshot every part of it sees), and whether it was written. Another
    // tenant's row, or this person's with the same keys, is left as it is.
    const { rows } = await this.pool.query<{ old_tenant: string | null; old_user: string | null; written: number; inserted: boolean | null }>(
      `WITH old AS (SELECT tenant_id, user_id FROM push_subscriptions WHERE endpoint = $1),
       up AS (
         INSERT INTO push_subscriptions (endpoint, tenant_id, user_id, p256dh, auth, created_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = EXCLUDED.created_at
         WHERE push_subscriptions.tenant_id = EXCLUDED.tenant_id
           AND (push_subscriptions.user_id, push_subscriptions.p256dh, push_subscriptions.auth) IS DISTINCT FROM (EXCLUDED.user_id, EXCLUDED.p256dh, EXCLUDED.auth)
         RETURNING (xmax = 0) AS inserted
       )
       SELECT (SELECT tenant_id FROM old) AS old_tenant, (SELECT user_id FROM old) AS old_user, (SELECT count(*) FROM up)::int AS written,
         (SELECT bool_and(inserted) FROM up) AS inserted`,
      [s.endpoint, s.tenantId, s.userId, s.p256dh, s.auth, s.createdAt]
    )
    // One row, always: a SELECT of scalar subqueries.
    const { old_tenant: oldTenant, old_user: oldUser, written, inserted } = rows[0]!
    if (oldTenant !== null && oldTenant !== s.tenantId) return { outcome: 'refused' }
    // Added meanwhile by a request of the same browser (its insert won): nothing more to do.
    if (!written) return { outcome: 'unchanged' }
    // Not in the snapshot yet updated: another request inserted it meanwhile (its insert won, this one waited on
    // it), for someone else or with other keys; whom is not known here (the snapshot predates it).
    if (oldUser === null) return inserted ? { outcome: 'added' } : { outcome: 'moved' }
    return oldUser === s.userId ? { outcome: 'updated' } : { outcome: 'moved', previousUserId: oldUser }
  }

  async deletePushSubscription(tenantId: string, userId: string, endpoint: string) {
    const r = await this.pool.query('DELETE FROM push_subscriptions WHERE tenant_id = $1 AND user_id = $2 AND endpoint = $3', [tenantId, userId, endpoint])
    return (r.rowCount ?? 0) > 0
  }

  async deletePushEndpoint(endpoint: string) {
    const { rows } = await this.pool.query<{ tenant_id: string; user_id: string }>('DELETE FROM push_subscriptions WHERE endpoint = $1 RETURNING tenant_id, user_id', [endpoint])
    return rows[0] ? { tenantId: rows[0].tenant_id, userId: rows[0].user_id } : null
  }

  async getVapidKeys(): Promise<VapidKeysRecord | null> {
    const { rows } = await this.pool.query<{ public_key: string; private_key_enc: string }>('SELECT public_key, private_key_enc FROM vapid_keys WHERE id = 1')
    return rows[0] ? { publicKey: rows[0].public_key, privateKeyEnc: rows[0].private_key_enc } : null
  }

  async initVapidKeys(keys: VapidKeysRecord) {
    await this.pool.query('INSERT INTO vapid_keys (id, public_key, private_key_enc) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING', [keys.publicKey, keys.privateKeyEnc])
    return (await this.getVapidKeys())!
  }

  async listTrunks(tenantId: string): Promise<TrunkRecord[]> {
    const { rows } = await this.pool.query<TrunkRow>('SELECT tenant_id, id, config, password_enc FROM trunk_configs WHERE tenant_id = $1 ORDER BY created_at, id', [tenantId])
    return rows.map(r => ({ tenantId: r.tenant_id, id: r.id, config: r.config, ...(r.password_enc !== null ? { passwordEnc: r.password_enc } : {}) }))
  }

  async upsertTrunk(t: TrunkRecord) {
    await this.upsertTrunks([t])
  }

  async upsertTrunks(records: TrunkRecord[]) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const t of records)
        await client.query(
          `INSERT INTO trunk_configs (tenant_id, id, config, password_enc) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, id) DO UPDATE SET config = EXCLUDED.config, password_enc = EXCLUDED.password_enc`,
          [t.tenantId, t.id, JSON.stringify(t.config), t.passwordEnc ?? null]
        )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  async deleteTrunk(tenantId: string, id: string) {
    const r = await this.pool.query('DELETE FROM trunk_configs WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    return (r.rowCount ?? 0) > 0
  }

  async listDids(tenantId: string): Promise<DidRecord[]> {
    const { rows } = await this.pool.query<DidRow>('SELECT * FROM direct_numbers WHERE tenant_id = $1 ORDER BY first_number, id', [tenantId])
    return rows.map(r => ({
      tenantId: r.tenant_id,
      id: r.id,
      trunkId: r.trunk_id,
      first: r.first_number,
      last: r.last_number,
      ...(r.target !== null ? { target: r.target } : {}),
      ...(r.suffix_digits ? { suffixDigits: r.suffix_digits } : {}),
      ...(r.fallback_target !== null ? { fallbackTarget: r.fallback_target } : {})
    }))
  }

  async upsertDid(d: DidRecord) {
    await this.pool.query(
      `INSERT INTO direct_numbers (tenant_id, id, trunk_id, first_number, last_number, target, suffix_digits, fallback_target) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, id) DO UPDATE SET trunk_id = EXCLUDED.trunk_id, first_number = EXCLUDED.first_number, last_number = EXCLUDED.last_number,
         target = EXCLUDED.target, suffix_digits = EXCLUDED.suffix_digits, fallback_target = EXCLUDED.fallback_target`,
      [d.tenantId, d.id, d.trunkId, d.first, d.last, d.target ?? null, d.suffixDigits ?? 0, d.fallbackTarget ?? null]
    )
  }

  async deleteDid(tenantId: string, id: string) {
    const r = await this.pool.query('DELETE FROM direct_numbers WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    return (r.rowCount ?? 0) > 0
  }

  async getOutbound(tenantId: string): Promise<OutboundRecord | null> {
    const { rows } = await this.pool.query<OutboundRow>('SELECT tenant_id, policy, profiles, assignments FROM outbound_policies WHERE tenant_id = $1', [tenantId])
    const r = rows[0]
    return r ? { tenantId: r.tenant_id, policy: r.policy, profiles: r.profiles, assignments: r.assignments } : null
  }

  /**
   * Runs `run` in a transaction that holds the tenant's outbound lock, with the rules kept: one writer of the tenant's
   * rules at a time in the whole database (a lock that holds whatever process writes, with a version or not, and
   * when there is no row yet). The SIP server is handed rules within it: no long wait of its own (its queries and
   * its reload have their own bounds), and none of its tables is locked here.
   */
  private async inOutboundTurn(tenantId: string, run: (client: pg.PoolClient, kept: OutboundRules) => Promise<void>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`outbound_policies|${tenantId}`])
      const { rows } = await client.query<OutboundRow>('SELECT tenant_id, policy, profiles, assignments FROM outbound_policies WHERE tenant_id = $1', [tenantId])
      const r = rows[0]
      await run(client, r ? { policy: r.policy, profiles: r.profiles, assignments: r.assignments } : EMPTY_OUTBOUND)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  async setOutbound(o: OutboundRecord, expected?: string, hand?: OutboundHand) {
    const { tenantId: _t, ...rules } = o
    // Written, then not committed: the SIP server gets back what was kept (the lock is gone by then; rare).
    let written: OutboundRules | undefined
    try {
      await this.inOutboundTurn(o.tenantId, async (client, kept) => {
        if (expected !== undefined && outboundVersion(kept) !== expected) throw staleOutbound()
        try {
          await hand?.(rules, false)
          await client.query(
            `INSERT INTO outbound_policies (tenant_id, policy, profiles, assignments) VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id) DO UPDATE SET policy = EXCLUDED.policy, profiles = EXCLUDED.profiles, assignments = EXCLUDED.assignments, updated_at = now()`,
            [o.tenantId, JSON.stringify(o.policy), JSON.stringify(o.profiles), JSON.stringify(o.assignments)]
          )
        } catch (err) {
          // Handed, then not kept (the SIP server refused, or the write failed): it gets back what is kept, in the turn.
          if (hand) await hand(kept, true).catch(() => undefined)
          throw err
        }
        written = kept
      })
    } catch (err) {
      if (hand && written) await hand(written, true).catch(() => undefined)
      throw err
    }
  }

  async holdOutbound(tenantId: string, run: (kept: OutboundRules) => Promise<void>) {
    await this.inOutboundTurn(tenantId, (_client, kept) => run(kept))
  }

  async addAlert(a: AlertRecord) {
    const key = alertKey(a.alert)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // One writer per alert at a time: two repeats at once count in one alert, never open two.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`telephony_alerts|${a.tenantId}|${key}`])
      const repeated = await client.query(
        // Never into an acknowledged one, even acknowledged while this waited for its row.
        `UPDATE telephony_alerts SET last_at = greatest(last_at, $3::timestamptz), count = count + 1, alert = $4
         WHERE acknowledged_at IS NULL AND id = (SELECT id FROM telephony_alerts WHERE tenant_id = $1 AND dedup_key = $2 AND last_at >= $3::timestamptz - make_interval(secs => $5) AND acknowledged_at IS NULL ORDER BY id DESC LIMIT 1)`,
        [a.tenantId, key, a.at, JSON.stringify(a.alert), ALERT_DEDUP_MS / 1000]
      )
      if (!repeated.rowCount)
        await client.query('INSERT INTO telephony_alerts (tenant_id, at, last_at, count, dedup_key, alert, first_alert) VALUES ($1, $2, $2, 1, $3, $4, $4)', [a.tenantId, a.at, key, JSON.stringify(a.alert)])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  async listAlerts(tenantId: string, query: AlertQuery = {}): Promise<StoredAlert[]> {
    const { rows } = await this.pool.query<AlertRow>(
      `SELECT ${ALERT_COLUMNS} FROM telephony_alerts
       WHERE tenant_id = $1 AND ($2::timestamptz IS NULL OR (last_at, id) < ($2::timestamptz, $3::bigint)) AND ($4::text IS NULL OR alert->>'kind' = $4) AND ($5::text IS NULL OR alert->>'param' = $5)
         AND ($7::text IS NULL OR ($7 = 'open') = (acknowledged_at IS NULL))
       ORDER BY last_at DESC, id DESC LIMIT $6`,
      [tenantId, query.before?.lastAt ?? null, query.before?.id ?? null, query.kind ?? null, query.param ?? null, clampLimit(query.limit), query.state ?? null]
    )
    return rows.map(alertOf)
  }

  async acknowledgeAlert(tenantId: string, id: string, by: string, at: string, seen: string, count: number) {
    if (!/^[1-9][0-9]{0,17}$/.test(id)) return null
    // The first acknowledgement stays: who did it, and when. Only as it was seen: a repeat counted since (its row
    // locked by this update, or updated before it) leaves it open. Times to the millisecond, as they are shown; the
    // count too, which a repeat always raises (its time may stay: the same millisecond, or one dated before).
    const { rows } = await this.pool.query<AlertRow>(
      `UPDATE telephony_alerts SET
         acknowledged_at = coalesce(acknowledged_at, CASE WHEN date_trunc('milliseconds', last_at) = $5::timestamptz AND count = $6 THEN $3::timestamptz END),
         acknowledged_by = coalesce(acknowledged_by, CASE WHEN date_trunc('milliseconds', last_at) = $5::timestamptz AND count = $6 THEN $4 END)
       WHERE tenant_id = $1 AND id = $2::bigint RETURNING ${ALERT_COLUMNS}`,
      [tenantId, id, at, by, seen, count]
    )
    return rows[0] ? alertOf(rows[0]) : null
  }

  async purgeAlerts(before: string) {
    const r = await this.pool.query('DELETE FROM telephony_alerts WHERE last_at < $1', [before])
    return r.rowCount ?? 0
  }

  async listWebhookSubscriptions(tenantId: string) {
    const { rows } = await this.pool.query<WebhookRow>('SELECT * FROM webhook_subscriptions WHERE tenant_id = $1 ORDER BY created_at, id', [tenantId])
    return rows.map(webhookOf)
  }

  async getWebhookSubscription(tenantId: string, id: string) {
    const { rows } = await this.pool.query<WebhookRow>('SELECT * FROM webhook_subscriptions WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    return rows[0] ? webhookOf(rows[0]) : null
  }

  /** Runs `run` in a transaction (rolled back when it throws). */
  /**
   * `run` in a transaction, run again once if PostgreSQL chose it as the victim of a deadlock (40P01) or a
   * serialization failure (40001): it was rolled back whole.
   */
  private async inTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.transactionOnce(run)
    } catch (err) {
      if (!retryable(err)) throw err
      return this.transactionOnce(run)
    }
  }

  private async transactionOnce<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const out = await run(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  async addWebhookSubscription(w: WebhookSubscriptionRecord, max: number) {
    return this.inTransaction(async client => {
      // One writer of a tenant's subscriptions at a time: the count and the write go together.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`webhook_subscriptions|${w.tenantId}`])
      const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_subscriptions WHERE tenant_id = $1', [w.tenantId])
      if ((rows[0]?.n ?? 0) >= max) return false
      await client.query(
        'INSERT INTO webhook_subscriptions (id, tenant_id, url, events, description, enabled, secret_enc, created_at, updated_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [w.id, w.tenantId, w.url, w.events, w.description ?? null, w.enabled, w.secretEnc, w.createdAt, w.updatedAt, w.createdBy ?? null]
      )
      return true
    })
  }

  async updateWebhookSubscription(w: WebhookSubscriptionRecord) {
    return this.inTransaction(async client => {
      if (!w.enabled) await this.lockPending(client, w.tenantId, w.id)
      // Every expression reads the row as it was: enabled again ($6 over a disabled one), it starts afresh.
      const r = await client.query(
        `UPDATE webhook_subscriptions SET url = $3, events = $4, description = $5, updated_at = $7,
           failures = CASE WHEN $6 AND NOT enabled THEN 0 ELSE failures END,
           failing_since = CASE WHEN $6 AND NOT enabled THEN NULL ELSE failing_since END,
           paused_until = CASE WHEN $6 AND NOT enabled THEN NULL ELSE paused_until END,
           backlog = CASE WHEN $6 AND NOT enabled THEN 0 ELSE backlog END,
           backlog_at = CASE WHEN $6 AND NOT enabled THEN NULL ELSE backlog_at END,
           disabled_reason = CASE WHEN $6 THEN NULL ELSE disabled_reason END,
           enabled = $6
         WHERE tenant_id = $1 AND id = $2`,
        [w.tenantId, w.id, w.url, w.events, w.description ?? null, w.enabled, w.updatedAt]
      )
      if (r.rowCount && !w.enabled) await this.failPending(client, w.id)
      return !!r.rowCount
    })
  }

  /**
   * Locks the pending deliveries of a subscription before the subscription is (one being disabled): in the order an
   * outcome (completeWebhookDelivery) and a claim lock them, the delivery then its subscription, never the other way
   * round (a deadlock).
   */
  private lockPending(client: pg.PoolClient, tenantId: string, subscriptionId: string) {
    return client.query("SELECT id FROM webhook_deliveries WHERE tenant_id = $1 AND subscription_id = $2 AND status = 'pending' ORDER BY id FOR UPDATE", [tenantId, subscriptionId])
  }

  private failPending(client: pg.PoolClient, subscriptionId: string) {
    return client.query(
      "UPDATE webhook_deliveries SET status = 'failed', last_error = 'disabled', next_attempt_at = NULL, claim = NULL, body = CASE WHEN erase_body THEN '' ELSE body END WHERE subscription_id = $1 AND status = 'pending'",
      [subscriptionId]
    )
  }

  async renewWebhookSecret(tenantId: string, id: string, secretEnc: string, keepPreviousUntil: string | null, at: string) {
    const r = await this.pool.query(
      'UPDATE webhook_subscriptions SET secret_prev_enc = CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE secret_enc END, secret_prev_until = $4, secret_enc = $3, updated_at = $5 WHERE tenant_id = $1 AND id = $2',
      [tenantId, id, secretEnc, keepPreviousUntil, at]
    )
    return !!r.rowCount
  }

  async pauseWebhookSubscription(tenantId: string, id: string, until: string | null) {
    await this.pool.query('UPDATE webhook_subscriptions SET paused_until = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, id, until])
  }

  async resumeWebhookSubscription(tenantId: string, id: string) {
    const r = await this.pool.query('UPDATE webhook_subscriptions SET paused_until = NULL, failures = 0, failing_since = NULL, backlog = 0, backlog_at = NULL WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    return !!r.rowCount
  }

  async disableFailingWebhookSubscription(tenantId: string, id: string, at: string) {
    return this.inTransaction(async client => {
      await this.lockPending(client, tenantId, id)
      const r = await client.query("UPDATE webhook_subscriptions SET enabled = false, disabled_reason = 'failing', updated_at = $3 WHERE tenant_id = $1 AND id = $2 AND enabled", [tenantId, id, at])
      if (r.rowCount) await this.failPending(client, id)
      return !!r.rowCount
    })
  }

  async deleteWebhookSubscription(tenantId: string, id: string) {
    const r = await this.pool.query('DELETE FROM webhook_subscriptions WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    return !!r.rowCount
  }

  /**
   * Whether a test or a replay may be sent now under `quota` (the caller holds the tenant's lock of the count): what
   * is older than the window goes first.
   */
  private async sendAllowed(client: pg.PoolClient, tenantId: string, subscriptionId: string, at: string | undefined, quota: WebhookSendQuota) {
    await client.query("DELETE FROM webhook_sends WHERE tenant_id = $1 AND at <= coalesce($2::timestamptz, now()) - $3 * interval '1 millisecond'", [tenantId, at ?? null, quota.windowMs])
    const { rows } = await client.query<{ mine: number; all: number }>('SELECT count(*) FILTER (WHERE subscription_id = $2)::int AS mine, count(*)::int AS all FROM webhook_sends WHERE tenant_id = $1', [tenantId, subscriptionId])
    return (rows[0]?.mine ?? 0) < quota.perSubscription && (quota.perTenant === undefined || (rows[0]?.all ?? 0) < quota.perTenant)
  }

  /** One count of a tenant's tests and replays at a time: two Gateways asked at once never both pass the last place. */
  private lockSends(client: pg.PoolClient, tenantId: string) {
    return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`webhook_sends|${tenantId}`])
  }

  private countSend(client: pg.PoolClient, tenantId: string, subscriptionId: string, at: string | undefined) {
    return client.query('INSERT INTO webhook_sends (tenant_id, subscription_id, at) VALUES ($1, $2, coalesce($3::timestamptz, now()))', [tenantId, subscriptionId, at ?? null])
  }

  async getWebhookDomains(tenantId: string) {
    const { rows } = await this.pool.query<{ domain: string }>('SELECT domain FROM webhook_domains WHERE tenant_id = $1 ORDER BY position', [tenantId])
    return rows.map(r => r.domain)
  }

  async setWebhookDomains(tenantId: string, domains: string[]) {
    await this.inTransaction(async client => {
      await client.query('DELETE FROM webhook_domains WHERE tenant_id = $1', [tenantId])
      if (domains.length) await client.query('INSERT INTO webhook_domains (tenant_id, position, domain) SELECT $1, n, d FROM unnest($2::text[]) WITH ORDINALITY AS u(d, n)', [tenantId, domains])
    })
  }

  /**
   * One event for each enabled subscription of the tenant that takes it; recorded failed (`backlog`) for one that
   * has `maxPending` pending already (counted up to that many, no further), and counted in its `backlog`. How many
   * were queued pending, and the subscriptions it was recorded failed for.
   */
  private async queueEvent(db: pg.Pool | pg.PoolClient, tenantId: string, eventId: string, eventType: WebhookEventType, body: string, at: Timestamp | undefined, options: WebhookQueueOptions = {}) {
    const { rows } = await db.query<{ status: string; subscription_id: string }>(
      `INSERT INTO webhook_deliveries (id, tenant_id, subscription_id, event_id, event_type, body, subject_user, status, last_error, created_at, next_attempt_at)
       SELECT ${NEW_DELIVERY_ID}, s.tenant_id, s.id, $2, $3, $4, $6,
              CASE WHEN f.full THEN 'failed' ELSE 'pending' END, CASE WHEN f.full THEN 'backlog' END, coalesce($5::timestamptz, now()), CASE WHEN f.full THEN NULL ELSE coalesce($5::timestamptz, now()) END
       FROM webhook_subscriptions s,
            LATERAL (SELECT $7::int IS NOT NULL AND (SELECT count(*) FROM (SELECT 1 FROM webhook_deliveries p WHERE p.subscription_id = s.id AND p.status = 'pending' LIMIT $7) x) >= $7 AS full) f
       WHERE s.tenant_id = $1 AND s.enabled AND $3 = ANY (s.events)
       ON CONFLICT (subscription_id, event_id) DO NOTHING
       RETURNING status, subscription_id`,
      [tenantId, eventId, eventType, body, at ?? null, options.subjectUser ?? null, options.maxPending ?? null]
    )
    const backlogged = rows.filter(r => r.status === 'failed').map(r => r.subscription_id)
    if (backlogged.length) await db.query('UPDATE webhook_subscriptions SET backlog = backlog + 1, backlog_at = coalesce($2::timestamptz, now()) WHERE id = ANY ($1)', [backlogged, at ?? null])
    return { queued: rows.length - backlogged.length, backlogged }
  }

  async enqueueWebhookEvent(tenantId: string, eventId: string, eventType: WebhookEventType, body: string, at: string | undefined, options?: WebhookQueueOptions) {
    const { queued, backlogged } = await this.queueEvent(this.pool, tenantId, eventId, eventType, body, at, options)
    if (backlogged.length) options?.onBacklog?.(backlogged)
    return queued
  }

  async enqueueWebhookDelivery(tenantId: string, subscriptionId: string, eventId: string, eventType: string, body: string, at: string | undefined, maxPending?: number, quota?: WebhookSendQuota) {
    return this.inTransaction(async client => {
      if (quota) await this.lockSends(client, tenantId)
      const { rows: found } = await client.query<{ n: number }>(
        "SELECT (SELECT count(*) FROM (SELECT 1 FROM webhook_deliveries p WHERE p.subscription_id = s.id AND p.status = 'pending' LIMIT $3) x)::int AS n FROM webhook_subscriptions s WHERE s.tenant_id = $1 AND s.id = $2",
        [tenantId, subscriptionId, maxPending ?? 1]
      )
      if (!found[0]) return null
      if (maxPending !== undefined && found[0].n >= maxPending) return 'full' as const
      if (quota && !(await this.sendAllowed(client, tenantId, subscriptionId, at, quota))) return 'rate' as const
      // The cap counted in the write itself: two asked at once never pass it both.
      const { rows } = await client.query<DeliveryRow>(
        `INSERT INTO webhook_deliveries (id, tenant_id, subscription_id, event_id, event_type, body, created_at, next_attempt_at)
         SELECT ${NEW_DELIVERY_ID}, s.tenant_id, s.id, $3, $4, $5, coalesce($6::timestamptz, now()), coalesce($6::timestamptz, now()) FROM webhook_subscriptions s
         WHERE s.tenant_id = $1 AND s.id = $2 AND ($7::int IS NULL OR (SELECT count(*) FROM (SELECT 1 FROM webhook_deliveries p WHERE p.subscription_id = s.id AND p.status = 'pending' LIMIT $7) x) < $7)
         ON CONFLICT (subscription_id, event_id) DO NOTHING RETURNING ${DELIVERY_COLUMNS}`,
        [tenantId, subscriptionId, eventId, eventType, body, at ?? null, maxPending ?? null]
      )
      if (!rows[0]) return maxPending !== undefined ? ('full' as const) : null
      if (quota) await this.countSend(client, tenantId, subscriptionId, at)
      return deliveryOf(rows[0])
    })
  }

  async claimWebhookDeliveries(limit: number, caps: WebhookClaimCaps, at?: WebhookClaimTime) {
    if (limit <= 0) return []
    const claim = randomBytes(12).toString('hex')
    return this.inTransaction(async client => {
      const { rows: times } = await client.query<{ now: Date; lease: Date }>(
        "SELECT coalesce($1::timestamptz, now()) AS now, coalesce($2::timestamptz, coalesce($1::timestamptz, now()) + $3 * interval '1 millisecond') AS lease",
        [at?.now ?? null, at?.leaseUntil ?? null, caps.leaseMs ?? 60_000]
      )
      const { now, lease } = times[0]!
      // The enabled subscriptions not paused that have a delivery due: one read of the index each, whatever waits behind
      // it (a subscription with a thousand pending costs as much as one with one).
      const { rows: ready } = await client.query<{ id: string; tenant_id: string; claimed_at: Timestamp | null; due: Timestamp }>(
        `SELECT s.id, s.tenant_id, s.claimed_at, f.next_attempt_at AS due FROM webhook_subscriptions s
         CROSS JOIN LATERAL (
           SELECT d.next_attempt_at FROM webhook_deliveries d
           WHERE d.subscription_id = s.id AND d.status = 'pending' AND d.next_attempt_at <= $1 AND d.attempts < $2
           ORDER BY d.next_attempt_at LIMIT 1
         ) f
         WHERE s.enabled AND (s.paused_until IS NULL OR s.paused_until <= $1)`,
        [now, caps.maxAttempts]
      )
      if (!ready.length) return []
      const subs = ready.map(r => ({ id: r.id, tenantId: r.tenant_id, dueAt: iso(r.due), ...(r.claimed_at ? { claimedAt: iso(r.claimed_at) } : {}) }))
      const heldOf = async (tenants: string[]) =>
        (
          await client.query<{ tenant_id: string; subscription_id: string; n: number }>(
            "SELECT tenant_id, subscription_id, count(*)::int AS n FROM webhook_deliveries WHERE tenant_id = ANY ($1) AND status = 'pending' AND claim IS NOT NULL AND next_attempt_at > $2 GROUP BY tenant_id, subscription_id",
            [tenants, now]
          )
        ).rows.map(h => ({ tenantId: h.tenant_id, subscriptionId: h.subscription_id, n: h.n }))
      // The tenants with room left, in the order they are served (those at their cap left out before any cut: they
      // never take the place of one that has room). Each claimed by one Gateway at a time: another passes it over
      // meanwhile and locks the next one, until there are as many as places.
      const order = claimOrder(caps, subs, await heldOf([...new Set(subs.map(r => r.tenantId))]))
      const tenants: string[] = []
      for (let i = 0; i < order.length && tenants.length < limit; ) {
        const batch = order.slice(i, i + limit - tenants.length)
        i += batch.length
        const { rows: locked } = await client.query<{ t: string }>(
          "SELECT t FROM unnest($1::text[]) WITH ORDINALITY AS u(t, n) WHERE pg_try_advisory_xact_lock(hashtextextended('webhook_claim|' || t, 0)) ORDER BY n",
          [batch]
        )
        tenants.push(...locked.map(r => r.t))
      }
      if (!tenants.length) return []
      // What they hold counted again under their lock: as it stands.
      const want = allocateClaims(
        limit,
        caps,
        subs.filter(r => tenants.includes(r.tenantId)),
        await heldOf(tenants)
      )
      if (!want.length) return []
      // SKIP LOCKED: one being completed or replayed meanwhile is left for the next claim. Each held until the
      // lease: if its outcome never comes (that Gateway stopped), it is due again then.
      const { rows } = await client.query<DeliveryRow & { url: string; secret_enc: string; secret_prev_enc: string | null }>(
        `WITH want AS (SELECT * FROM unnest($1::text[], $2::int[]) AS w(sub, n)),
         due AS (
           SELECT x.id FROM want CROSS JOIN LATERAL (
             SELECT d.id FROM webhook_deliveries d
             WHERE d.subscription_id = want.sub AND d.status = 'pending' AND d.next_attempt_at <= $3 AND d.attempts < $4
             ORDER BY d.next_attempt_at, d.id LIMIT want.n FOR UPDATE OF d SKIP LOCKED
           ) x
         )
         UPDATE webhook_deliveries d SET attempts = d.attempts + 1, last_attempt_at = $3, next_attempt_at = $5, claim = $6
         FROM due, webhook_subscriptions s WHERE d.id = due.id AND s.id = d.subscription_id
         RETURNING ${DELIVERY_COLUMNS.split(', ').map(c => `d.${c}`).join(', ')}, s.url, s.secret_enc, CASE WHEN s.secret_prev_until > $3 THEN s.secret_prev_enc END AS secret_prev_enc`,
        [want.map(w => w.subscriptionId), want.map(w => w.n), now, caps.maxAttempts, lease, claim]
      )
      // When each was last served (after its deliveries: the order an outcome locks them in).
      const served = [...new Set(rows.map(r => r.subscription_id))]
      if (served.length) await client.query('UPDATE webhook_subscriptions SET claimed_at = $2 WHERE id = ANY ($1)', [served, now])
      return rows
        .map((r): ClaimedDelivery => ({ ...deliveryOf(r), url: r.url, secretEnc: r.secret_enc, ...(r.secret_prev_enc ? { secretPrevEnc: r.secret_prev_enc } : {}), claim }))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1))
    })
  }

  async sweepWebhookDeliveries(maxAttempts: number, now?: string) {
    const r = await this.pool.query(
      "UPDATE webhook_deliveries SET status = 'failed', last_error = 'abandoned', next_attempt_at = NULL, claim = NULL, body = CASE WHEN erase_body THEN '' ELSE body END WHERE status = 'pending' AND attempts >= $1 AND next_attempt_at <= coalesce($2::timestamptz, now())",
      [maxAttempts, now ?? null]
    )
    return r.rowCount ?? 0
  }

  async completeWebhookDelivery(id: string, claim: string, result: WebhookAttemptResult): Promise<WebhookHealth | null> {
    // The outcome and the subscription's health in one statement: a delivery starts it afresh, a failure adds one.
    // Dated on the database's clock unless the result names a time; a body erased meanwhile goes once it is done.
    const subscription = `UPDATE webhook_subscriptions s SET
         failures = CASE WHEN $3 THEN 0 ELSE s.failures + 1 END,
         failing_since = CASE WHEN $3 THEN NULL ELSE coalesce(s.failing_since, coalesce($4::timestamptz, now())) END,
         paused_until = CASE WHEN $3 THEN NULL ELSE s.paused_until END
       FROM d WHERE s.id = d.subscription_id RETURNING s.failures, s.failing_since, coalesce($4::timestamptz, now()) AS at`
    type Health = { failures: number; failing_since: Timestamp | null; at: Timestamp }
    // Run again once as a deadlock's victim (rolled back whole).
    const query = async (text: string, values: unknown[]) => {
      try {
        return await this.pool.query<Health>(text, values)
      } catch (err) {
        if (!retryable(err)) throw err
        return this.pool.query<Health>(text, values)
      }
    }
    const { rows } = result.delivered
      ? await query(
          `WITH d AS (
             UPDATE webhook_deliveries SET status = 'delivered', delivered_at = coalesce($4::timestamptz, now()), last_status = $5, last_error = NULL, next_attempt_at = NULL, claim = NULL,
               body = CASE WHEN erase_body THEN '' ELSE body END
             WHERE id = $1 AND claim = $2 AND status = 'pending' RETURNING subscription_id
           ) ${subscription}`,
          [id, claim, true, result.at ?? null, result.status]
        )
      : await query(
          `WITH r AS (SELECT coalesce($5::timestamptz, now() + $8 * interval '1 millisecond') AS next),
           d AS (
             UPDATE webhook_deliveries SET status = CASE WHEN r.next IS NULL THEN 'failed' ELSE 'pending' END, next_attempt_at = r.next, last_status = $6, last_error = $7, claim = NULL,
               body = CASE WHEN erase_body AND r.next IS NULL THEN '' ELSE body END
             FROM r WHERE id = $1 AND claim = $2 AND status = 'pending' RETURNING subscription_id
           ) ${subscription}`,
          [id, claim, false, result.at ?? null, result.retryAt ?? null, result.status ?? null, result.error, result.retryInMs ?? null]
        )
    const r = rows[0]
    return r ? { failures: r.failures, ...(r.failing_since ? { failingSince: iso(r.failing_since) } : {}), at: iso(r.at) } : null
  }

  async listWebhookDeliveries(tenantId: string, subscriptionId: string, query: WebhookDeliveryQuery = {}) {
    const { rows } = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries
       WHERE tenant_id = $1 AND subscription_id = $2 AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::text)) AND ($5::text IS NULL OR status = $5)
       ORDER BY created_at DESC, id DESC LIMIT $6`,
      [tenantId, subscriptionId, query.before?.createdAt ?? null, query.before?.id ?? null, query.status ?? null, clampLimit(query.limit)]
    )
    return rows.map(deliveryOf)
  }

  async replayWebhookDelivery(tenantId: string, subscriptionId: string, id: string, at?: string, maxPending?: number, quota?: WebhookSendQuota) {
    return this.inTransaction(async client => {
      if (quota) await this.lockSends(client, tenantId)
      const found = async () =>
        (
          await client.query<{ status: string; erase_body: boolean; n: number }>(
            `SELECT d.status, d.erase_body, (SELECT count(*) FROM (SELECT 1 FROM webhook_deliveries p WHERE p.subscription_id = d.subscription_id AND p.status = 'pending' LIMIT $4) x)::int AS n
             FROM webhook_deliveries d WHERE d.tenant_id = $1 AND d.subscription_id = $2 AND d.id = $3`,
            [tenantId, subscriptionId, id, maxPending ?? 1]
          )
        ).rows[0]
      const refused = (f: Awaited<ReturnType<typeof found>>) => {
        // One its person asked to erase is not sent again (its body is gone).
        if (!f || f.erase_body) return null
        if (f.status === 'pending') return 'pending' as const
        if (maxPending !== undefined && f.n >= maxPending) return 'full' as const
        return undefined
      }
      const before = refused(await found())
      if (before !== undefined) return before
      if (quota && !(await this.sendAllowed(client, tenantId, subscriptionId, at, quota))) return 'rate' as const
      const { rows } = await client.query<DeliveryRow>(
        `UPDATE webhook_deliveries d SET status = 'pending', attempts = 0, next_attempt_at = coalesce($4::timestamptz, now()), claim = NULL, last_status = NULL, last_error = NULL, delivered_at = NULL
         WHERE d.tenant_id = $1 AND d.subscription_id = $2 AND d.id = $3 AND d.status <> 'pending'
           AND ($5::int IS NULL OR (SELECT count(*) FROM (SELECT 1 FROM webhook_deliveries p WHERE p.subscription_id = d.subscription_id AND p.status = 'pending' LIMIT $5) x) < $5)
         RETURNING ${DELIVERY_COLUMNS}`,
        [tenantId, subscriptionId, id, at ?? null, maxPending ?? null]
      )
      if (!rows[0]) return refused(await found()) ?? ('pending' as const)
      if (quota) await this.countSend(client, tenantId, subscriptionId, at)
      return deliveryOf(rows[0])
    })
  }

  async purgeWebhookDeliveries(before: string) {
    const client = await this.pool.connect()
    try {
      // One Gateway purges, the others pass their turn; by batches, so that no statement holds the table long.
      const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('webhook_purge', 0)) AS ok")
      if (!rows[0]?.ok) return 0
      try {
        let purged = 0
        for (;;) {
          const r = await client.query("DELETE FROM webhook_deliveries WHERE ctid IN (SELECT ctid FROM webhook_deliveries WHERE created_at < $1 AND status <> 'pending' LIMIT $2)", [before, PURGE_BATCH])
          purged += r.rowCount ?? 0
          if ((r.rowCount ?? 0) < PURGE_BATCH) break
        }
        await client.query("DELETE FROM webhook_state WHERE state = 'removed' AND since < $1", [before])
        return purged
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtextextended('webhook_purge', 0))")
      }
    } finally {
      client.release()
    }
  }

  async eraseWebhookSubject(tenantId: string, userId: string) {
    return this.inTransaction(async client => {
      const r = await client.query("DELETE FROM webhook_deliveries WHERE tenant_id = $1 AND subject_user = $2 AND status <> 'pending'", [tenantId, userId])
      await client.query("UPDATE webhook_deliveries SET erase_body = true WHERE tenant_id = $1 AND subject_user = $2 AND status = 'pending'", [tenantId, userId])
      await client.query('DELETE FROM webhook_state WHERE tenant_id = $1 AND subject = $2', [tenantId, `presence:${userId}`])
      return r.rowCount ?? 0
    })
  }

  async setWebhookState(change: WebhookStateChange, event: WebhookStateEvent, options?: WebhookQueueOptions) {
    const { tenantId, subject, state, holder } = change
    const out = await this.inTransaction(async client => {
      // Told by the Gateway that holds the lease only, within the part of it its holder writes in: the row is read, not
      // locked (a renewal never waits for the writes under way), and another Gateway that takes the lease over writes
      // once the margin left after it is past (takeWebhookLease).
      const lease = await client.query('SELECT 1 FROM webhook_leases WHERE role = $1 AND holder = $2 AND write_from <= clock_timestamp() AND write_until > clock_timestamp()', [WEBHOOK_STATE_ROLE, holder])
      if (!lease.rowCount) return null
      // One writer of a subject at a time (a lock that holds whether its row exists yet or not), its change dated on
      // the database's clock once it holds it: two changes are dated in the order they are written.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`webhook_state|${tenantId}|${subject}`])
      // Compared in the database, to the microsecond: two changes within a millisecond are two changes.
      const { rows: times } = await client.query<{ at: Date; exact: string }>('SELECT x AS at, x::text AS exact FROM (SELECT coalesce($1::timestamptz, clock_timestamp()) AS x) q', [change.at ?? null])
      const { at, exact } = times[0]!
      const { rows } = await client.query<{ state: string; newer: boolean }>('SELECT state, since >= $3::timestamptz AS newer FROM webhook_state WHERE tenant_id = $1 AND subject = $2', [tenantId, subject, exact])
      const before = rows[0]
      if (before && (before.state === state || before.newer)) return null
      await client.query('INSERT INTO webhook_state (tenant_id, subject, state, since) VALUES ($1, $2, $3, $4::timestamptz) ON CONFLICT (tenant_id, subject) DO UPDATE SET state = EXCLUDED.state, since = EXCLUDED.since', [tenantId, subject, state, exact])
      const e = event(before?.state, iso(at))
      const { queued, backlogged } = e ? await this.queueEvent(client, tenantId, e.id, e.type, e.body, at, { ...options, ...(e.subjectUser ? { subjectUser: e.subjectUser } : {}) }) : { queued: 0, backlogged: [] }
      return { previous: before?.state, queued, backlogged }
    })
    if (!out) return null
    if (out.backlogged.length) options?.onBacklog?.(out.backlogged)
    return { previous: out.previous, queued: out.queued }
  }

  async takeWebhookLease(role: string, holder: string, ms: number, heard = 0): Promise<WebhookLease | null> {
    // On a connection of its own: a pool busy with a rush of writes never holds a renewal until the lease lapses.
    if (ms <= 0) {
      // Given back: another takes it at once, and writes once what this one was writing is done.
      await this.leasePool.query('UPDATE webhook_leases SET until = least(until, now()), write_until = least(write_until, now()) WHERE role = $1 AND holder = $2', [role, holder])
      return null
    }
    // Taken from another holder when it lapsed, or at once when this one hears more tenants than it does: it writes
    // from a third of the lease after what the other could still write (none once it lapsed).
    const margin = Math.floor(ms / 3)
    const { rows } = await this.leasePool.query<{ write_from: Timestamp }>(
      `INSERT INTO webhook_leases (role, holder, until, heard, write_from, write_until)
       VALUES ($1, $2, now() + $3 * interval '1 millisecond', $4, now(), now() + ($3 - $5) * interval '1 millisecond')
       ON CONFLICT (role) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until, heard = EXCLUDED.heard, write_until = EXCLUDED.write_until,
         write_from = CASE WHEN webhook_leases.holder = EXCLUDED.holder THEN webhook_leases.write_from
                           ELSE greatest(now(), least(webhook_leases.write_until, now()) + $5 * interval '1 millisecond') END
       WHERE webhook_leases.holder = EXCLUDED.holder OR webhook_leases.until <= now() OR EXCLUDED.heard > webhook_leases.heard
       RETURNING write_from`,
      [role, holder, ms, heard, margin]
    )
    return rows[0] ? { writeFrom: iso(rows[0].write_from) } : null
  }

  async listWebhookStates(tenantId: string, prefix: string) {
    const { rows } = await this.pool.query<{ subject: string; state: string }>(
      "SELECT subject, state FROM webhook_state WHERE tenant_id = $1 AND starts_with(subject, $2) ORDER BY subject",
      [tenantId, prefix]
    )
    return rows
  }

  async clock() {
    const { rows } = await this.leasePool.query<{ now: Timestamp }>('SELECT clock_timestamp() AS now')
    return iso(rows[0]!.now)
  }

  async close() {
    await Promise.all([this.pool.end(), this.leasePool.end()])
  }
}
