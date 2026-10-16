import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { EMPTY_OUTBOUND, outboundVersion, staleOutbound } from '../outbound.js'
import { ALERT_DEDUP_MS, alertKey, clampLimit, type AlertQuery, type AlertRecord, type StoredAlert, type ConferenceRecord, type DidRecord, type OutboundHand, type OutboundRecord, type OutboundRules, type HistoryEntry, type HistoryPage, type HistoryQuery, type MappingSource, type ProviderRecord, type PushSaveResult, type PushSubscriptionRecord, type Store, type TrunkRecord, type UserMapping, type UserPresenceRecord, type VapidKeysRecord } from './types.js'

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url))

// The rows as the tables hold them (migrations/), as pg hands them: timestamptz as Date, NULL as null. `query<Row>`
// is a claim the compiler cannot check: the storage contract (contract.ts), run against PostgreSQL, is what checks it.
type Timestamp = Date | string
type ProviderRow = { tenant_id: string; site: string; type: string; config: unknown }
type MappingRow = { tenant_id: string; user_id: string; extension: string; display_name: string | null; department: string | null; source: MappingSource; synced_at: Timestamp | null }
type HistoryRow = { tenant_id: string; user_id: string; call_id: string; direction: HistoryEntry['direction']; remote_number: string; started_at: Timestamp; ended_at: Timestamp | null; duration_sec: number; state: HistoryEntry['state']; answered: boolean }
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

  async close() {
    await this.pool.end()
  }
}
