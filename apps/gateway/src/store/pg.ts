import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { clampLimit, type ConferenceRecord, type HistoryEntry, type HistoryPage, type HistoryQuery, type MappingSource, type ProviderRecord, type PushSaveResult, type PushSubscriptionRecord, type Store, type UserMapping, type UserPresenceRecord, type VapidKeysRecord } from './types.js'

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url))

// The rows as the tables hold them (migrations/), as pg hands them: timestamptz as Date, NULL as null.
type Timestamp = Date | string
type ProviderRow = { tenant_id: string; site: string; type: string; config: unknown }
type MappingRow = { tenant_id: string; user_id: string; extension: string; display_name: string | null; department: string | null; source: MappingSource | null; synced_at: Timestamp | null }
type HistoryRow = { tenant_id: string; user_id: string; call_id: string; direction: HistoryEntry['direction']; remote_number: string; started_at: Timestamp; ended_at: Timestamp | null; duration_sec: number; state: HistoryEntry['state']; answered: boolean }
type PresenceRow = { tenant_id: string; user_id: string; status: UserPresenceRecord['status']; since: Timestamp; until: Timestamp | null; message: string | null }
type ConferenceRow = { tenant_id: string; meeting_id: string; owner_user_id: string; pin: string | null; created_at: Timestamp }
type PushRow = { tenant_id: string; user_id: string; endpoint: string; p256dh: string; auth: string; created_at: Timestamp }

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
  answered: r.answered
})

/** PostgreSQL store. Every statement is parameterised and carries the tenant. */
export class PgStore implements Store {
  private readonly pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 })
  }

  /** Applies the SQL files of migrations/ not yet applied, in order, each in a transaction. */
  async migrate() {
    await this.pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    const done = new Set((await this.pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(r => r.name))
    for (const file of (await readdir(MIGRATIONS)).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(await readFile(MIGRATIONS + file, 'utf8'))
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
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
      source: r.source ?? 'manual',
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
    await this.pool.query('DELETE FROM user_mappings WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
  }

  async addHistory(e: HistoryEntry) {
    await this.pool.query(
      `INSERT INTO call_history (tenant_id, user_id, call_id, direction, remote_number, started_at, ended_at, duration_sec, state, answered)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
      [e.tenantId, e.userId, e.callId, e.direction, e.remoteNumber, e.startedAt, e.endedAt ?? null, e.durationSec, e.state, e.answered]
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
    const { rows } = await this.pool.query(
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
    const { old_tenant: oldTenant, old_user: oldUser, written, inserted } = rows[0] as { old_tenant: string | null; old_user: string | null; written: number; inserted: boolean | null }
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

  async close() {
    await this.pool.end()
  }
}
