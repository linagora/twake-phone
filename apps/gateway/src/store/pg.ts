import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { clampLimit, type ConferenceRecord, type HistoryEntry, type HistoryPage, type HistoryQuery, type ProviderRecord, type Store, type UserMapping } from './types.js'

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url))

const toEntry = (r: Record<string, any>): HistoryEntry => ({
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
    const done = new Set((await this.pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name))
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
    const { rows } = await this.pool.query('SELECT tenant_id, site, type, config FROM provider_configs ORDER BY id')
    return rows.map(r => ({ tenantId: r.tenant_id, site: r.site, type: r.type, config: r.config }))
  }

  async upsertProvider(r: ProviderRecord) {
    await this.pool.query(
      `INSERT INTO provider_configs (tenant_id, site, type, config) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, site) DO UPDATE SET type = EXCLUDED.type, config = EXCLUDED.config`,
      [r.tenantId, r.site ?? 'default', r.type, JSON.stringify(r.config)]
    )
  }

  private mapping(r: Record<string, any> | undefined): UserMapping | null {
    return r ? { tenantId: r.tenant_id, userId: r.user_id, extension: r.extension, ...(r.display_name ? { displayName: r.display_name } : {}) } : null
  }

  async getMappingByUser(tenantId: string, userId: string) {
    const { rows } = await this.pool.query('SELECT * FROM user_mappings WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
    return this.mapping(rows[0])
  }

  async getMappingByExtension(tenantId: string, extension: string) {
    const { rows } = await this.pool.query('SELECT * FROM user_mappings WHERE tenant_id = $1 AND extension = $2', [tenantId, extension])
    return this.mapping(rows[0])
  }

  async upsertMapping(m: UserMapping) {
    await this.pool.query(
      `INSERT INTO user_mappings (tenant_id, user_id, extension, display_name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET extension = EXCLUDED.extension, display_name = EXCLUDED.display_name`,
      [m.tenantId, m.userId, m.extension, m.displayName ?? null]
    )
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
    if (q.status === 'missed') where.push("direction = 'inbound' AND answered = false")
    if (q.status === 'answered') where.push('answered = true')
    if (q.status === 'failed') where.push("state = 'failed'")
    if (q.number) add("remote_number LIKE '%' || ? || '%'", q.number.replace(/[\\%_]/g, c => `\\${c}`))
    if (q.from) add('started_at >= ?', q.from)
    if (q.to) add('started_at <= ?', q.to)
    if (q.before) add('started_at < ?', q.before)
    args.push(limit + 1)
    const { rows } = await this.pool.query(`SELECT * FROM call_history WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT $${args.length}`, args)
    const items = rows.slice(0, limit).map(toEntry)
    return { items, ...(rows.length > limit ? { next: items.at(-1)!.startedAt } : {}) }
  }

  async deleteHistory(tenantId: string, userId: string) {
    const r = await this.pool.query('DELETE FROM call_history WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
    return r.rowCount ?? 0
  }

  async getSipSecret(tenantId: string, userId: string) {
    const { rows } = await this.pool.query('SELECT secret_enc, rotated_at FROM sip_credentials WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
    return rows[0] ? { secretEnc: rows[0].secret_enc, rotatedAt: new Date(rows[0].rotated_at).toISOString() } : null
  }

  async setSipSecret(tenantId: string, userId: string, secretEnc: string) {
    await this.pool.query(
      `INSERT INTO sip_credentials (tenant_id, user_id, secret_enc) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, rotated_at = now()`,
      [tenantId, userId, secretEnc]
    )
  }

  private conference(r: Record<string, any> | undefined): ConferenceRecord | null {
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
    const { rows } = await this.pool.query('SELECT * FROM conferences WHERE meeting_id = $1', [meetingId])
    return this.conference(rows[0])
  }

  async setConferencePin(meetingId: string, pin: string | null) {
    await this.pool.query('UPDATE conferences SET pin = $2 WHERE meeting_id = $1', [meetingId, pin])
  }

  async deleteConference(meetingId: string) {
    await this.pool.query('DELETE FROM conferences WHERE meeting_id = $1', [meetingId])
  }

  async close() {
    await this.pool.end()
  }
}
