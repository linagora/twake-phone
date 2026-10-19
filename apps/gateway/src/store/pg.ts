import { randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { EMPTY_OUTBOUND, outboundVersion, staleOutbound } from '../outbound.js'
import { ALERT_DEDUP_MS, alertKey, clampLimit, type AlertQuery, type AlertRecord, type StoredAlert, type ConferenceDecision, type ConferenceRecord, type DidRecord, type SiteRecord, type OutboundHand, type OutboundRecord, type OutboundRules, type HistoryEntry, type HistoryNearQuery, type HistoryPage, type HistoryQuery, type OperatorCdrOutcome, type OperatorCdrRecord, type OperatorCdrStats, type MappingSource, type ErasedCallsKept, type ProviderRecord, type PushSaveResult, type PushSubscriptionRecord, type Store, type TrunkRecord, type MappingChange, type UserMapping, type UserPresenceRecord, type VapidKeysRecord, type ClaimedDelivery, type WebhookAttemptResult, type WebhookClaimCaps, type WebhookClaimTime, allocateClaims, claimOrder, type WebhookDeliveryQuery, type WebhookLease, type WebhookSendQuota, type WebhookDeliveryRecord, type WebhookHealth, type WebhookQueueOptions, type WebhookStateChange, type WebhookStateEvent, type WebhookSubscriptionRecord, WEBHOOK_STATE_ROLE , type FencedLease, type NewTranscript, type TranscriptChange, type TranscriptLane, holderIn, holderOut, type TranscriptMatch, type TranscriptNotice, type TranscriptRecord } from './types.js'
import type { OperatorCdr, WebhookEventType } from '@twake/telephony-types'

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url))

// The rows as the tables hold them (migrations/), as pg hands them: timestamptz as Date, NULL as null. `query<Row>`
// is a claim the compiler cannot check: the storage contract (contract.ts), run against PostgreSQL, is what checks it.
type Timestamp = Date | string
type ProviderRow = { tenant_id: string; site: string; type: string; config: unknown }
type MappingRow = { tenant_id: string; user_id: string; extension: string; display_name: string | null; department: string | null; source: MappingSource; synced_at: Timestamp | null }
type HistoryRow = { tenant_id: string; user_id: string; call_id: string; direction: HistoryEntry['direction']; remote_number: string; started_at: Timestamp; ended_at: Timestamp | null; duration_sec: number; state: HistoryEntry['state']; answered: boolean; conference: boolean; operator: string | null; operator_cdr: string | null; operator_only: boolean; operator_forwarded: boolean; voicemail: boolean }
type OperatorCdrRow = { tenant_id: string; operator: string; id: string; line: string; direction: HistoryEntry['direction']; forwarded: boolean; calling: string | null; called: string | null; started_at: Timestamp; duration_sec: number; outcome: OperatorCdrRecord['outcome'] | null; call_id: string | null; user_id: string | null; invalid: string | null }
type PresenceRow = { tenant_id: string; user_id: string; status: UserPresenceRecord['status']; since: Timestamp; until: Timestamp | null; message: string | null }
type ConferenceRow = { tenant_id: string; meeting_id: string; owner_user_id: string; pin: string | null; origin_call: string | null; decision: ConferenceDecision | null; created_at: Timestamp }
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

interface TranscriptRow {
  tenant_id: string
  holder: string
  message_id: string
  extension: string
  received_at: Timestamp
  status: TranscriptRecord['status']
  reason: TranscriptRecord['reason'] | null
  text: string | null
  attempts: number
  next_at: Timestamp
  notice: TranscriptRecord['notice']
  notice_attempts: number
  notice_next_at: Timestamp
  notice_room: string | null
  notice_event: string | null
  notice_edit: string | null
  created_at: Timestamp
  updated_at: Timestamp
}
const transcriptOf = (r: TranscriptRow): TranscriptRecord => ({
  tenantId: r.tenant_id,
  holder: holderOut(r.holder),
  messageId: r.message_id,
  extension: r.extension,
  receivedAt: iso(r.received_at),
  status: r.status,
  ...(r.reason ? { reason: r.reason } : {}),
  ...(r.text !== null ? { text: r.text } : {}),
  attempts: r.attempts,
  nextAt: iso(r.next_at),
  notice: r.notice,
  noticeAttempts: r.notice_attempts,
  noticeNextAt: iso(r.notice_next_at),
  ...(r.notice_room ? { noticeRoom: r.notice_room } : {}),
  ...(r.notice_event ? { noticeEvent: r.notice_event } : {}),
  ...(r.notice_edit ? { noticeEdit: r.notice_edit } : {}),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
})
/** The columns a change of a transcription may set (updateTranscript). */
const TRANSCRIPT_COLUMNS: Record<keyof TranscriptChange, string> = { status: 'status', reason: 'reason', text: 'text', attempts: 'attempts', nextAt: 'next_at', notice: 'notice', noticeAttempts: 'notice_attempts', noticeNextAt: 'notice_next_at', noticeRoom: 'notice_room', noticeEvent: 'notice_event', noticeEdit: 'notice_edit' }
/** Whether the lease ($1 role, $2 holder, $3 generation) is held now within its write window: in the statement that writes. */
const LEASE_HELD = 'EXISTS (SELECT 1 FROM webhook_leases WHERE role = $1 AND holder = $2 AND generation = $3 AND write_from <= clock_timestamp() AND write_until > clock_timestamp())'
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
/**
 * A time written to the microsecond in UTC, whatever the DateStyle and TimeZone of the session (fourth review 10b,
 * n°8): `::text` follows DateStyle, and an abbreviated zone (IST) is read back as another one.
 */
const UTC_TEXT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'

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
  ...(r.conference ? { conference: true } : {}),
  ...(r.operator ? { operator: r.operator } : {}),
  ...(r.operator_cdr ? { operatorCdr: r.operator_cdr } : {}),
  ...(r.operator_only ? { operatorOnly: true } : {}),
  ...(r.operator_forwarded ? { operatorForwarded: true } : {}),
  ...(r.voicemail ? { voicemail: true } : {})
})

const toOperatorCdr = (r: OperatorCdrRow): OperatorCdrRecord => ({
  tenantId: r.tenant_id,
  operator: r.operator,
  id: r.id,
  line: r.line,
  direction: r.direction,
  ...(r.calling !== null ? { calling: r.calling } : {}),
  ...(r.called !== null ? { called: r.called } : {}),
  startedAt: new Date(r.started_at).toISOString(),
  durationSec: r.duration_sec,
  ...(r.forwarded ? { forwarded: true as const } : {}),
  ...(r.invalid !== null ? { invalid: r.invalid } : {}),
  ...(r.outcome ? { outcome: r.outcome } : {}),
  ...(r.call_id ? { callId: r.call_id } : {}),
  ...(r.user_id ? { userId: r.user_id } : {})
})

/** The advisory lock of a person's history: their erasure, and an entry known from the operator alone (review 10b, n°1). */
const historyLock = (tenantId: string, userId: string) => `call_history|${tenantId}|${userId}`

/** The window of matchCdrs (RECONCILE_EARLY_MS, RECONCILE_LATE_MS), in SQL: an erased entry would take a record in it. */
const NEAR_WINDOW = "c.started_at >= h.started_at - interval '60 seconds' AND c.started_at <= coalesce(h.ended_at, h.started_at) + interval '60 seconds'"

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
  /** Transactions run again after a deadlock or a serialization failure (inTransaction): read by the tests. */
  private retried = 0

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 })
    this.leasePool = new pg.Pool({ connectionString, max: 1 })
    // Times read and written in ISO whatever the server's or the role's DateStyle (fourth review 10b, n°8): pg reads
    // ISO dates only, and a time sent back as text must read as the same one. Queued before any query of the client.
    for (const pool of [this.pool, this.leasePool]) pool.on('connect', client => void client.query("SET DateStyle = 'ISO, MDY'").catch(() => undefined))
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
    await this.inTransaction(async client => {
      await this.upsertMappingIn(client, m)
      await this.stampNumberChanges(client, m.tenantId)
    })
  }

  /**
   * The rows of `number_changes` a change of mappings writes are dated 'infinity' until this, just before its COMMIT:
   * now() would be the time of its BEGIN, and a call of the operator that started while it ran (waiting on locks
   * perhaps) would pass for one after the change, in the history of whom the extension rings now. Rows of other
   * transactions not committed yet are not seen; committed, they carry their own time.
   */
  private async stampNumberChanges(client: pg.PoolClient, tenantId: string) {
    await client.query("UPDATE number_changes SET changed_at = clock_timestamp() WHERE tenant_id = $1 AND kind = 'extension' AND changed_at = 'infinity'", [tenantId])
  }

  private async upsertMappingIn(client: pg.PoolClient, m: UserMapping) {
    const { rows } = await client.query<{ extension: string }>('SELECT extension FROM user_mappings WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE', [m.tenantId, m.userId])
    await client.query(
      `INSERT INTO user_mappings (tenant_id, user_id, extension, display_name, department, source, synced_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET extension = EXCLUDED.extension, display_name = EXCLUDED.display_name,
         department = EXCLUDED.department, source = EXCLUDED.source, synced_at = EXCLUDED.synced_at`,
      [m.tenantId, m.userId, m.extension, m.displayName ?? null, m.department ?? null, m.source ?? 'manual', m.syncedAt ?? null]
    )
    const before = rows[0]?.extension
    if (before === m.extension) return
    // The extension it had changes hands (second review 10b, n°3); the one it takes too, when someone held it lately.
    // Dated at the COMMIT (stampNumberChanges).
    if (before !== undefined) await client.query("INSERT INTO number_changes (tenant_id, kind, first_number, last_number, changed_at) VALUES ($1, 'extension', $2, $2, 'infinity')", [m.tenantId, before])
    await client.query(
      `INSERT INTO number_changes (tenant_id, kind, first_number, last_number, changed_at)
       SELECT $1, 'extension', $2, $2, 'infinity' WHERE EXISTS (SELECT 1 FROM number_changes WHERE tenant_id = $1 AND kind = 'extension' AND first_number = $2)`,
      [m.tenantId, m.extension]
    )
  }

  async applyMappings(tenantId: string, change: MappingChange) {
    if (change.write.some(m => m.tenantId !== tenantId)) throw new Error('applyMappings: a mapping of another tenant')
    return this.inTransaction(async client => {
      const failed: { userId: string; err: unknown }[] = []
      for (const r of change.remove) await this.deleteMappingIn(client, tenantId, r.userId, r.left ? { left: true } : {})
      for (const m of change.write) {
        // Each write on its own: one refused leaves the others, and the removals, as they are.
        await client.query('SAVEPOINT mapping_write')
        try {
          await this.upsertMappingIn(client, m)
          await client.query('RELEASE SAVEPOINT mapping_write')
        } catch (err) {
          if (retryable(err)) throw err
          await client.query('ROLLBACK TO SAVEPOINT mapping_write')
          failed.push({ userId: m.userId, err })
        }
      }
      await this.stampNumberChanges(client, tenantId)
      return { failed }
    })
  }

  async listMappings(tenantId: string) {
    const { rows } = await this.pool.query<MappingRow>('SELECT * FROM user_mappings WHERE tenant_id = $1 ORDER BY user_id', [tenantId])
    return rows.map(r => this.mapping(r)!)
  }

  async deleteMapping(tenantId: string, userId: string, opts: { left?: boolean } = {}) {
    await this.inTransaction(async client => {
      await this.deleteMappingIn(client, tenantId, userId, opts)
      await this.stampNumberChanges(client, tenantId)
    })
  }

  private async deleteMappingIn(client: pg.PoolClient, tenantId: string, userId: string, opts: { left?: boolean }) {
    // What was told of their presence goes with them (it is kept otherwise, whatever its age).
    // Its extension changes hands (second review 10b, n°3).
    // Dated at the COMMIT (stampNumberChanges).
    await client.query(
      "INSERT INTO number_changes (tenant_id, kind, first_number, last_number, changed_at) SELECT tenant_id, 'extension', extension, extension, 'infinity' FROM user_mappings WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, userId]
    )
    await client.query('DELETE FROM user_mappings WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
    // Their erasure goes with them once they left (third review 10b, n°3): neither who nor their numbers are kept.
    // Given another extension, it stays (fourth review n°2).
    if (opts.left) await client.query('DELETE FROM history_erasures WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
    await client.query('DELETE FROM webhook_state WHERE tenant_id = $1 AND subject = $2', [tenantId, `presence:${userId}`])
  }

  async addHistory(e: HistoryEntry, client: pg.Pool | pg.PoolClient = this.pool) {
    await client.query(
      `INSERT INTO call_history (tenant_id, user_id, call_id, direction, remote_number, started_at, ended_at, duration_sec, state, answered, conference, operator, operator_cdr, operator_only, operator_forwarded, voicemail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT DO NOTHING`,
      [e.tenantId, e.userId, e.callId, e.direction, e.remoteNumber, e.startedAt, e.endedAt ?? null, e.durationSec, e.state, e.answered, e.conference === true, e.operator ?? null, e.operatorCdr ?? null, e.operatorOnly === true, e.operatorForwarded === true, e.voicemail === true]
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

  async deleteHistory(tenantId: string, userId: string, numbers: readonly string[] = [], calls?: ErasedCallsKept) {
    return this.inTransaction(async client => {
      // When, kept with the erasure: an orphan settled meanwhile waits for it, and sees it (settleOperatorCdrs).
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [historyLock(tenantId, userId)])
      // The operator's records it changes, locked first, all in one order (third review 10b, n°13: as settleOperatorCdrs
      // locks them): never two transactions holding one each of two records.
      await client.query(
        `SELECT 1 FROM operator_cdrs c WHERE c.tenant_id = $1 AND (
            c.user_id = $2 OR c.call_id IN (SELECT call_id FROM call_history WHERE tenant_id = $1 AND user_id = $2)
            OR (c.started_at < now() AND (c.calling = ANY($3::text[]) OR c.called = ANY($3::text[])))
            OR (c.outcome IS NULL AND EXISTS (
              SELECT 1 FROM call_history h WHERE h.tenant_id = $1 AND h.user_id = $2 AND h.direction = c.direction
                AND h.remote_e164 = e164_of(CASE WHEN c.direction = 'inbound' THEN c.calling ELSE c.called END) AND ${NEAR_WINDOW})))
          ORDER BY c.operator, c.id FOR UPDATE OF c`,
        [tenantId, userId, [...numbers]]
      )
      await client.query(
        `INSERT INTO history_erasures (tenant_id, user_id, erased_at, numbers) VALUES ($1, $2, now(), $3::text[])
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET erased_at = EXCLUDED.erased_at, numbers = EXCLUDED.numbers`,
        [tenantId, userId, [...numbers]]
      )
      // The operator's records of their calls keep no number of them (kept as read, never read again): reconciled with
      // their entries; to or from their direct numbers before now; not reconciled yet, one of their entries would take
      // (second review 10b, n°2: an outbound call presented with a trunk's number). Those not reconciled: `erased`.
      await client.query(
        `UPDATE operator_cdrs SET calling = NULL, called = NULL WHERE tenant_id = $1 AND (user_id = $2 OR call_id IN (SELECT call_id FROM call_history WHERE tenant_id = $1 AND user_id = $2))`,
        [tenantId, userId]
      )
      if (numbers.length)
        await client.query(
          `UPDATE operator_cdrs SET calling = NULL, called = NULL, outcome = coalesce(outcome, 'erased')
            WHERE tenant_id = $1 AND started_at < now() AND (calling = ANY($2::text[]) OR called = ANY($2::text[]))`,
          [tenantId, [...numbers]]
        )
      await client.query(
        `UPDATE operator_cdrs c SET calling = NULL, called = NULL, outcome = 'erased'
          WHERE c.tenant_id = $1 AND c.outcome IS NULL AND EXISTS (
            SELECT 1 FROM call_history h WHERE h.tenant_id = $1 AND h.user_id = $2 AND h.direction = c.direction
              AND h.remote_e164 = e164_of(CASE WHEN c.direction = 'inbound' THEN c.calling ELSE c.called END) AND ${NEAR_WINDOW})`,
        [tenantId, userId]
      )
      // When they were, without a number but a keyed print of it (third review n°5): a record read later that no other
      // entry takes is erased too. Only as asked (n°3): an organisation with an operator, the entries a record read
      // later may be of.
      if (calls) {
        const { rows: remotes } = await client.query<{ e164: string }>('SELECT DISTINCT remote_e164 AS e164 FROM call_history WHERE tenant_id = $1 AND user_id = $2 AND started_at >= $3 AND remote_e164 IS NOT NULL', [
          tenantId,
          userId,
          calls.since
        ])
        const keys = calls.keyOf ? remotes.map(r => ({ e164: r.e164, key: calls.keyOf!(r.e164) })) : []
        await client.query(
          `INSERT INTO history_erased_calls (tenant_id, direction, started_at, ended_at, remote_key)
           SELECT h.tenant_id, h.direction, h.started_at, coalesce(h.ended_at, h.started_at), k.key
             FROM call_history h LEFT JOIN jsonb_to_recordset($4::jsonb) AS k(e164 text, key text) ON k.e164 = h.remote_e164
            WHERE h.tenant_id = $1 AND h.user_id = $2 AND h.started_at >= $3`,
          [tenantId, userId, calls.since, JSON.stringify(keys)]
        )
      }
      const r = await client.query('DELETE FROM call_history WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
      return r.rowCount ?? 0
    })
  }

  async historyErasedAt(tenantId: string, userId: string) {
    const { rows } = await this.pool.query<{ erased_at: Timestamp }>('SELECT erased_at FROM history_erasures WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
    return rows[0] ? new Date(rows[0].erased_at).toISOString() : undefined
  }

  async numbersErasedAt(tenantId: string, numbers: readonly string[]) {
    if (!numbers.length) return new Map<string, string>()
    const { rows } = await this.pool.query<{ number: string; at: Timestamp }>(
      'SELECT n AS number, max(e.erased_at) AS at FROM history_erasures e, unnest(e.numbers) AS n WHERE e.tenant_id = $1 AND n = ANY($2::text[]) GROUP BY n',
      [tenantId, [...numbers]]
    )
    return new Map(rows.map(r => [r.number, new Date(r.at).toISOString()]))
  }

  async erasedCalls(tenantId: string, from: string, to: string) {
    const { rows } = await this.pool.query<{ direction: HistoryEntry['direction']; started_at: Timestamp; ended_at: Timestamp; remote_key: string | null }>(
      'SELECT direction, started_at, ended_at, remote_key FROM history_erased_calls WHERE tenant_id = $1 AND started_at >= $2 AND started_at <= $3',
      [tenantId, from, to]
    )
    return rows.map(r => ({ direction: r.direction, startedAt: new Date(r.started_at).toISOString(), endedAt: new Date(r.ended_at).toISOString(), ...(r.remote_key ? { remoteKey: r.remote_key } : {}) }))
  }

  async numberChangedAt(tenantId: string, extension: string, number: string) {
    const { rows } = await this.pool.query<{ at: Timestamp | null }>(
      `SELECT max(changed_at) AS at FROM number_changes WHERE tenant_id = $1
          AND ((kind = 'extension' AND first_number = $2) OR (kind = 'did' AND length(first_number) = length($3) AND first_number <= $3 AND last_number >= $3))`,
      [tenantId, extension, number]
    )
    return rows[0]?.at ? new Date(rows[0].at).toISOString() : undefined
  }

  async knownOperatorCdrs(tenantId: string, operator: string, ids: readonly string[]) {
    if (!ids.length) return []
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM operator_cdrs WHERE tenant_id = $1 AND operator = $2 AND id = ANY($3::text[])', [tenantId, operator, ids])
    return rows.map(r => r.id)
  }

  async addOperatorCdrs(tenantId: string, operator: string, cdrs: readonly OperatorCdr[]) {
    if (!cdrs.length) return
    await this.pool.query(
      `INSERT INTO operator_cdrs (tenant_id, operator, id, line, direction, forwarded, calling, called, started_at, duration_sec, invalid)
       SELECT $1, $2, c.id, c.line, c.direction, c.forwarded, c.calling, c.called, c.started_at, c.duration_sec, c.invalid
         FROM jsonb_to_recordset($3::jsonb) AS c(id text, line text, direction text, forwarded boolean, calling text, called text, started_at timestamptz, duration_sec integer, invalid text)
       ON CONFLICT DO NOTHING`,
      [tenantId, operator, JSON.stringify(cdrs.map(c => ({ id: c.id, line: c.line, direction: c.direction, forwarded: c.forwarded === true, calling: c.calling, called: c.called, started_at: c.startedAt, duration_sec: c.durationSec, invalid: c.invalid ?? null })))]
    )
  }

  async pendingOperatorCdrs(tenantId: string, operator: string, readBefore: string, limit: number) {
    const { rows } = await this.pool.query<OperatorCdrRow>(
      'SELECT * FROM operator_cdrs WHERE tenant_id = $1 AND operator = $2 AND outcome IS NULL AND read_at < $3 ORDER BY started_at, id LIMIT $4',
      [tenantId, operator, readBefore, limit]
    )
    return rows.map(toOperatorCdr)
  }

  async historyNear(tenantId: string, q: HistoryNearQuery) {
    // By way, number (call_history_near, remote_e164 as e164Of writes it) or person (call_history_by_user), and time.
    // Ordered at the millisecond, as the cursor is written (second review 10b, n°13: a start in microseconds, written
    // by SQL, never brings the same page back).
    const { rows } = await this.pool.query<HistoryRow>(
      `SELECT * FROM call_history
        WHERE tenant_id = $1 AND direction = $2 AND started_at >= $3 AND started_at <= $4 AND NOT operator_only
          AND ($5::text[] IS NULL OR remote_e164 = ANY($5::text[])) AND ($6::text IS NULL OR user_id = $6)
          AND ($7 OR operator_cdr IS NULL)
          AND ($9::timestamptz IS NULL OR (date_trunc('milliseconds', started_at), call_id COLLATE "C", user_id COLLATE "C") > ($9::timestamptz, $10::text COLLATE "C", $11::text COLLATE "C"))
        ORDER BY date_trunc('milliseconds', started_at), call_id COLLATE "C", user_id COLLATE "C" LIMIT $8`,
      [tenantId, q.direction, q.from, q.to, q.remotes ? [...q.remotes] : null, q.userId ?? null, q.reconciled === true, q.limit, q.after?.startedAt ?? null, q.after?.callId ?? null, q.after?.userId ?? null]
    )
    return rows.map(toEntry)
  }

  async operatorForwardsNear(tenantId: string, operator: string, line: string, from: string, to: string) {
    const { rows } = await this.pool.query<OperatorCdrRow>(
      'SELECT * FROM operator_cdrs WHERE tenant_id = $1 AND operator = $2 AND line = $3 AND forwarded AND started_at >= $4 AND started_at <= $5 ORDER BY started_at, id',
      [tenantId, operator, line, from, to]
    )
    return rows.map(toOperatorCdr)
  }

  async settleOperatorCdrs(tenantId: string, operator: string, outcomes: readonly OperatorCdrOutcome[]) {
    if (!outcomes.length) return
    await this.inTransaction(async client => {
      // Never in the history of a person who erased it since the call (review 10b, n°1): each person's erasure is
      // waited for (deleteHistory holds the same lock), then read; the locks taken in one order, before any row's.
      const users = [...new Set(outcomes.flatMap(o => (o.outcome === 'orphan' && o.entry ? [o.entry.userId] : [])))].sort()
      const erased = new Map<string, string>()
      for (const u of users) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [historyLock(tenantId, u)])
        const { rows } = await client.query<{ erased_at: Timestamp }>('SELECT erased_at FROM history_erasures WHERE tenant_id = $1 AND user_id = $2', [tenantId, u])
        if (rows[0]) erased.set(u, new Date(rows[0].erased_at).toISOString())
      }
      // The records, locked in one statement, by id (third review 10b, n°13: the order deleteHistory locks them in too).
      // The first word kept: a record another Gateway settled meanwhile is left as it is.
      const { rows: open } = await client.query<{ id: string }>('SELECT id FROM operator_cdrs WHERE tenant_id = $1 AND operator = $2 AND id = ANY($3::text[]) AND outcome IS NULL ORDER BY id FOR UPDATE', [
        tenantId,
        operator,
        [...new Set(outcomes.map(o => o.id))]
      ])
      const locked = new Set(open.map(r => r.id))
      for (const o of outcomes) {
        // Each settled once (its first outcome kept).
        if (!locked.delete(o.id)) continue
        const after = o.outcome === 'orphan' && o.entry ? erased.get(o.entry.userId) : undefined
        const erase = o.erase === true || o.outcome === 'erased' || (after !== undefined && after >= o.entry!.startedAt)
        if (erase) await client.query('UPDATE operator_cdrs SET calling = NULL, called = NULL WHERE tenant_id = $1 AND operator = $2 AND id = $3', [tenantId, operator, o.id])
        let outcome: OperatorCdrRecord['outcome'] = o.outcome === 'forwarded' || o.outcome === 'invalid' ? o.outcome : erase ? 'erased' : 'unmatched'
        let callId: string | null = null
        let userId: string | null = null
        if (erase && o.outcome !== 'matched') {
          // Kept as read, without a number, and in nobody's history.
        } else if (o.outcome === 'matched' && o.callId) {
          const linked = await client.query(
            'UPDATE call_history SET operator = $3, operator_cdr = $4 WHERE tenant_id = $1 AND call_id = $2 AND operator_cdr IS NULL AND NOT operator_only',
            [tenantId, o.callId, operator, o.id]
          )
          if (linked.rowCount) [outcome, callId] = ['matched', o.callId]
        } else if (o.outcome === 'orphan' && o.entry) {
          await this.addHistory({ ...o.entry, tenantId, operator, operatorCdr: o.id, operatorOnly: true }, client)
          ;[outcome, callId, userId] = ['orphan', o.entry.callId, o.entry.userId]
        }
        await client.query('UPDATE operator_cdrs SET outcome = $4, call_id = $5, user_id = $6 WHERE tenant_id = $1 AND operator = $2 AND id = $3', [tenantId, operator, o.id, outcome, callId, userId])
      }
    })
  }

  async operatorCdrStats(tenantId: string, operator: string, since: string): Promise<OperatorCdrStats> {
    const { rows } = await this.pool.query<{ outcome: string | null; direction: string; n: string }>(
      'SELECT outcome, direction, count(*) AS n FROM operator_cdrs WHERE tenant_id = $1 AND operator = $2 AND started_at >= $3 GROUP BY outcome, direction',
      [tenantId, operator, since]
    )
    const stats: OperatorCdrStats = { total: 0, matched: 0, orphan: 0, unmatchedInbound: 0, unmatchedOutbound: 0, forwarded: 0, pending: 0, invalid: 0, erased: 0 }
    for (const r of rows) {
      const n = Number(r.n)
      stats.total += n
      if (!r.outcome) stats.pending += n
      else if (r.outcome === 'unmatched') stats[r.direction === 'inbound' ? 'unmatchedInbound' : 'unmatchedOutbound'] += n
      else if (r.outcome === 'matched' || r.outcome === 'orphan' || r.outcome === 'forwarded' || r.outcome === 'invalid' || r.outcome === 'erased') stats[r.outcome] += n
    }
    return stats
  }

  async purgeErasures(before: string) {
    let purged = 0
    for (const sql of ['DELETE FROM history_erased_calls WHERE started_at < $1', 'DELETE FROM number_changes WHERE changed_at < $1', 'DELETE FROM history_erasures WHERE erased_at < $1'])
      purged += (await this.pool.query(sql, [before])).rowCount ?? 0
    return purged
  }

  async purgeOperatorCdrs(before: string) {
    let purged = 0
    for (;;) {
      const r = await this.pool.query('DELETE FROM operator_cdrs WHERE ctid IN (SELECT ctid FROM operator_cdrs WHERE started_at < $1 LIMIT $2)', [before, PURGE_BATCH])
      purged += r.rowCount ?? 0
      if ((r.rowCount ?? 0) < PURGE_BATCH) return purged
    }
  }

  async getOperatorState(tenantId: string, key: string): Promise<unknown> {
    const { rows } = await this.pool.query<{ value: unknown }>('SELECT value FROM operator_state WHERE tenant_id = $1 AND key = $2', [tenantId, key])
    return rows[0]?.value
  }

  async listOperatorState(tenantId: string, prefix: string) {
    const { rows } = await this.pool.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM operator_state WHERE tenant_id = $1 AND left(key, length($2)) = $2 ORDER BY key COLLATE \"C\"",
      [tenantId, prefix]
    )
    return rows
  }

  async putOperatorState(tenantId: string, key: string, value: unknown) {
    await this.pool.query(
      'INSERT INTO operator_state (tenant_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [tenantId, key, JSON.stringify(value)]
    )
  }

  async deleteOperatorState(tenantId: string, key: string, ifValue?: unknown) {
    const r = await this.pool.query('DELETE FROM operator_state WHERE tenant_id = $1 AND key = $2 AND ($3::jsonb IS NULL OR value = $3::jsonb)', [tenantId, key, ifValue === undefined ? null : JSON.stringify(ifValue)])
    return (r.rowCount ?? 0) > 0
  }

  async takeOperatorQuota(tenantId: string, key: string, windowMs: number, max: number) {
    return this.inTransaction(async client => {
      // The uses of the last window, in operator_state under `quota:<key>`: one Gateway counts at a time.
      const k = `quota:${key}`
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`operator_quota|${tenantId}|${k}`])
      const { rows } = await client.query<{ value: unknown; now: Timestamp }>('SELECT (SELECT value FROM operator_state WHERE tenant_id = $1 AND key = $2) AS value, now() AS now', [tenantId, k])
      const now = new Date(rows[0]!.now).getTime()
      const used = (Array.isArray(rows[0]?.value) ? (rows[0].value as unknown[]) : []).filter((at): at is number => typeof at === 'number' && at > now - windowMs)
      if (used.length >= max) return false
      used.push(now)
      await client.query(
        'INSERT INTO operator_state (tenant_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        [tenantId, k, JSON.stringify(used)]
      )
      return true
    })
  }

  async addTranscript(record: NewTranscript, lease: FencedLease, maxPending: number, whenFull: 'busy' | 'wait' = 'busy') {
    return this.inTransaction(async client => {
      // One writer of the tenant's queue at a time: the pending ones counted and the new one added together. The lease
      // checked in the statement that writes, once the lock is had (a long wait for it never writes under a lease gone).
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`voicemail_transcripts|${record.tenantId}`])
      const holder = holderIn(record.holder)
      const there = await client.query('SELECT 1 FROM voicemail_transcripts WHERE tenant_id = $1 AND holder = $2 AND message_id = $3', [record.tenantId, holder, record.messageId])
      if (there.rowCount) return 'exists' as const
      const { rows } = await client.query<{ n: string }>("SELECT count(*) AS n FROM voicemail_transcripts WHERE tenant_id = $1 AND status = 'pending'", [record.tenantId])
      const busy = record.status === 'pending' && Number(rows[0]!.n) >= maxPending
      if (busy && whenFull === 'wait') return 'full' as const
      const added = await client.query(
        `INSERT INTO voicemail_transcripts (tenant_id, holder, message_id, extension, received_at, status, reason, notice) SELECT $4, $5, $6, $7, $8::timestamptz, $9, $10, $11 WHERE ${LEASE_HELD}`,
        [lease.role, lease.holder, lease.generation, record.tenantId, holder, record.messageId, record.extension, record.receivedAt, busy ? 'none' : record.status, busy ? 'busy' : (record.reason ?? null), record.notice]
      )
      if (!added.rowCount) return 'fenced' as const
      return busy ? ('busy' as const) : ('added' as const)
    })
  }

  async updateTranscript(tenantId: string, holder: string, messageId: string, change: TranscriptChange, lease: FencedLease, ifNotice?: TranscriptNotice) {
    const sets: string[] = []
    const args: unknown[] = [lease.role, lease.holder, lease.generation, tenantId, holderIn(holder), messageId]
    for (const [k, column] of Object.entries(TRANSCRIPT_COLUMNS) as [keyof TranscriptChange, string][]) {
      const v = change[k]
      if (v === undefined) continue
      args.push(v)
      sets.push(`${column} = $${args.length}`)
    }
    if (ifNotice !== undefined) args.push(ifNotice)
    const { rowCount } = await this.pool.query(
      `UPDATE voicemail_transcripts SET ${[...sets, 'updated_at = clock_timestamp()'].join(', ')} WHERE tenant_id = $4 AND holder = $5 AND message_id = $6${ifNotice !== undefined ? ` AND notice = $${args.length}` : ''} AND ${LEASE_HELD}`,
      args
    )
    return !!rowCount
  }

  async deleteTranscript(tenantId: string, holder: string, messageId: string, lease: FencedLease) {
    const { rowCount } = await this.pool.query(`DELETE FROM voicemail_transcripts WHERE tenant_id = $4 AND holder = $5 AND message_id = $6 AND ${LEASE_HELD}`, [lease.role, lease.holder, lease.generation, tenantId, holderIn(holder), messageId])
    return !!rowCount
  }

  async eraseTranscripts(tenantId: string, match: TranscriptMatch, lease: FencedLease, withdraw: boolean) {
    const where = ['tenant_id = $4', "status <> 'erased'"]
    const args: unknown[] = [lease.role, lease.holder, lease.generation, tenantId]
    if ('before' in match) where.push(`received_at < $${args.push(match.before)}::timestamptz`)
    else {
      where.push(`holder = $${args.push(holderIn(match.holder))}`)
      if (match.messageId !== undefined) where.push(`message_id = $${args.push(match.messageId)}`)
    }
    const w = where.join(' AND ')
    // One statement: the lease read once, each text gone at once, a row kept while the bot's notice is to withdraw.
    const { rows } = await this.pool.query<{ held: boolean; kept: string; gone: string; notices: string }>(
      `WITH held AS (SELECT ${LEASE_HELD} AS ok),
        kept AS (UPDATE voicemail_transcripts SET status = 'erased', text = NULL, reason = NULL, notice = 'redact', notice_attempts = 0, notice_next_at = clock_timestamp(), updated_at = clock_timestamp()
                 WHERE ${w} AND notice_event IS NOT NULL AND ${withdraw ? 'true' : 'false'} AND (SELECT ok FROM held) RETURNING 1),
        gone AS (DELETE FROM voicemail_transcripts WHERE ${w} AND (notice_event IS NULL OR ${withdraw ? 'false' : 'true'}) AND (SELECT ok FROM held) RETURNING notice_event)
      SELECT (SELECT ok FROM held) AS held, (SELECT count(*) FROM kept) AS kept, (SELECT count(*) FROM gone) AS gone, (SELECT count(notice_event) FROM gone) AS notices`,
      args
    )
    const r = rows[0]!
    if (!r.held) return null
    return { erased: Number(r.kept) + Number(r.gone), notices: Number(r.kept) + Number(r.notices) }
  }

  async listTranscripts(tenantId: string, holder: string, messageIds?: string[], withErased = false) {
    const { rows } = await this.pool.query<TranscriptRow>(
      `SELECT * FROM voicemail_transcripts WHERE tenant_id = $1 AND holder = $2${withErased ? '' : " AND status <> 'erased'"}${messageIds ? ' AND message_id = ANY($3::text[])' : ''} ORDER BY created_at, message_id`,
      messageIds ? [tenantId, holderIn(holder), messageIds] : [tenantId, holderIn(holder)]
    )
    return rows.map(transcriptOf)
  }

  async dueTranscripts(tenantId: string, lane: TranscriptLane, limit: number, noticeWaitMs?: number, skip: string[] = []) {
    const { rows } = await this.pool.query<TranscriptRow>(
      lane === 'transcribe'
        ? `SELECT * FROM voicemail_transcripts WHERE tenant_id = $1 AND status = 'pending' AND next_at <= clock_timestamp() AND NOT (holder = ANY($3::text[])) ORDER BY created_at, message_id LIMIT $2`
        : `SELECT * FROM voicemail_transcripts WHERE tenant_id = $1 AND notice_next_at <= clock_timestamp() AND NOT (holder = ANY($4::text[]))
             AND (notice IN ('redact', 'edit') OR (notice = 'pending' AND (status <> 'pending' OR ($3::float8 IS NOT NULL AND created_at <= clock_timestamp() - make_interval(secs => $3::float8 / 1000)))))
           ORDER BY (notice = 'redact') DESC, created_at, message_id LIMIT $2`,
      lane === 'transcribe' ? [tenantId, Math.max(0, limit), skip.map(holderIn)] : [tenantId, Math.max(0, limit), noticeWaitMs ?? null, skip.map(holderIn)]
    )
    return rows.map(transcriptOf)
  }

  async staleTranscripts(tenantId: string, before: string) {
    const { rows } = await this.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM voicemail_transcripts WHERE tenant_id = $1 AND created_at < $2::timestamptz AND (status = 'pending' OR notice IN ('pending', 'edit', 'redact'))",
      [tenantId, before]
    )
    return Number(rows[0]!.n)
  }

  async transcriptsChangedSince(tenantId: string, since: string, limit: number) {
    const { rows } = await this.pool.query<TranscriptRow>(
      `SELECT * FROM voicemail_transcripts WHERE tenant_id = $1 AND status IN ('done', 'none') AND date_trunc('milliseconds', updated_at) > $2::timestamptz ORDER BY updated_at, message_id LIMIT $3`,
      [tenantId, since, Math.max(0, limit)]
    )
    return rows.map(transcriptOf)
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
      ? { tenantId: r.tenant_id, meetingId: r.meeting_id, ownerUserId: r.owner_user_id, ...(r.pin ? { pin: r.pin } : {}), ...(r.origin_call ? { originCall: r.origin_call } : {}), ...(r.decision ? { decision: r.decision } : {}), createdAt: new Date(r.created_at).toISOString() }
      : null
  }

  async claimConference(c: ConferenceRecord) {
    await this.pool.query(
      'INSERT INTO conferences (meeting_id, tenant_id, owner_user_id, pin, origin_call, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (meeting_id) DO NOTHING',
      [c.meetingId, c.tenantId, c.ownerUserId, c.pin ?? null, c.originCall ?? null, c.createdAt]
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

  async decideConference(meetingId: string, decision: ConferenceDecision) {
    const { rows } = await this.pool.query<{ decision: ConferenceDecision }>('UPDATE conferences SET decision = coalesce(decision, $2) WHERE meeting_id = $1 RETURNING decision', [meetingId, decision])
    return rows[0]?.decision ?? null
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
    return this.inTransaction(async client => {
      // Its direct numbers go with it: they change hands (second review 10b, n°3).
      await client.query(
        "INSERT INTO number_changes (tenant_id, kind, first_number, last_number) SELECT tenant_id, 'did', first_number, last_number FROM direct_numbers WHERE tenant_id = $1 AND trunk_id = $2",
        [tenantId, id]
      )
      const r = await client.query('DELETE FROM trunk_configs WHERE tenant_id = $1 AND id = $2', [tenantId, id])
      return (r.rowCount ?? 0) > 0
    })
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
    await this.inTransaction(async client => {
      const { rows } = await client.query<DidRow>('SELECT * FROM direct_numbers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [d.tenantId, d.id])
      await client.query(
        `INSERT INTO direct_numbers (tenant_id, id, trunk_id, first_number, last_number, target, suffix_digits, fallback_target) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, id) DO UPDATE SET trunk_id = EXCLUDED.trunk_id, first_number = EXCLUDED.first_number, last_number = EXCLUDED.last_number,
           target = EXCLUDED.target, suffix_digits = EXCLUDED.suffix_digits, fallback_target = EXCLUDED.fallback_target`,
        [d.tenantId, d.id, d.trunkId, d.first, d.last, d.target ?? null, d.suffixDigits ?? 0, d.fallbackTarget ?? null]
      )
      const before = rows[0]
      if (before && before.first_number === d.first && before.last_number === d.last && before.target === (d.target ?? null) && before.suffix_digits === (d.suffixDigits ?? 0)) return
      // What it rang changes hands (second review 10b, n°3); the numbers it takes too, when they changed hands lately.
      if (before) await client.query("INSERT INTO number_changes (tenant_id, kind, first_number, last_number) VALUES ($1, 'did', $2, $3)", [d.tenantId, before.first_number, before.last_number])
      await client.query(
        `INSERT INTO number_changes (tenant_id, kind, first_number, last_number)
         SELECT $1, 'did', $2, $3 WHERE EXISTS (SELECT 1 FROM number_changes WHERE tenant_id = $1 AND kind = 'did' AND length(first_number) = length($2) AND first_number <= $3 AND last_number >= $2)`,
        [d.tenantId, d.first, d.last]
      )
    })
  }

  async deleteDid(tenantId: string, id: string) {
    return this.inTransaction(async client => {
      await client.query("INSERT INTO number_changes (tenant_id, kind, first_number, last_number) SELECT tenant_id, 'did', first_number, last_number FROM direct_numbers WHERE tenant_id = $1 AND id = $2", [tenantId, id])
      const r = await client.query('DELETE FROM direct_numbers WHERE tenant_id = $1 AND id = $2', [tenantId, id])
      return (r.rowCount ?? 0) > 0
    })
  }

  async listSites(tenantId: string): Promise<SiteRecord[]> {
    const { rows } = await this.pool.query<{ id: string; name: string; address: string; trunk_id: string; number: string; members: string[] }>(
      `SELECT s.id, s.name, s.address, s.trunk_id, s.number, coalesce(array_agg(m.user_id ORDER BY m.user_id COLLATE "C") FILTER (WHERE m.user_id IS NOT NULL), '{}') AS members
       FROM sites s LEFT JOIN site_members m ON m.tenant_id = s.tenant_id AND m.site_id = s.id WHERE s.tenant_id = $1 GROUP BY s.tenant_id, s.id ORDER BY s.id COLLATE "C"`,
      [tenantId]
    )
    return rows.map(r => ({ tenantId, id: r.id, name: r.name, address: r.address, trunkId: r.trunk_id, number: r.number, members: r.members }))
  }

  async upsertSite(s: SiteRecord) {
    await this.inTransaction(async client => {
      await client.query(
        `INSERT INTO sites (tenant_id, id, name, address, trunk_id, number) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, trunk_id = EXCLUDED.trunk_id, number = EXCLUDED.number`,
        [s.tenantId, s.id, s.name, s.address, s.trunkId, s.number]
      )
      // Its members: those it names (taken from the site they were in), no others.
      await client.query('DELETE FROM site_members WHERE tenant_id = $1 AND (site_id = $2 OR user_id = ANY($3::text[]))', [s.tenantId, s.id, s.members])
      if (s.members.length)
        await client.query('INSERT INTO site_members (tenant_id, user_id, site_id) SELECT $1, u, $2 FROM unnest($3::text[]) AS w(u)', [s.tenantId, s.id, [...new Set(s.members)]])
    })
  }

  async deleteSite(tenantId: string, id: string) {
    const r = await this.pool.query('DELETE FROM sites WHERE tenant_id = $1 AND id = $2', [tenantId, id])
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
      this.retried++
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
    return this.inTransaction(async client => {
      // Its deliveries locked before it, in the order a claim and an outcome lock them (the cascade would lock the
      // subscription first, then them: a deadlock with either).
      await client.query('SELECT id FROM webhook_deliveries WHERE tenant_id = $1 AND subscription_id = $2 ORDER BY id FOR UPDATE', [tenantId, id])
      const r = await client.query('DELETE FROM webhook_subscriptions WHERE tenant_id = $1 AND id = $2', [tenantId, id])
      return !!r.rowCount
    })
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

  /**
   * One test or replay of a subscription written at a time (after lockSends, never before): its pending ones counted
   * and the new one written together, two asked at once never both pass the cap.
   */
  private lockSubscriptionSends(client: pg.PoolClient, subscriptionId: string) {
    return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`webhook_pending|${subscriptionId}`])
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
      await this.lockSubscriptionSends(client, subscriptionId)
      const { rows: found } = await client.query<{ n: number }>(
        "SELECT (SELECT count(*) FROM (SELECT 1 FROM webhook_deliveries p WHERE p.subscription_id = s.id AND p.status = 'pending' LIMIT $3) x)::int AS n FROM webhook_subscriptions s WHERE s.tenant_id = $1 AND s.id = $2",
        [tenantId, subscriptionId, maxPending ?? 1]
      )
      if (!found[0]) return null
      if (maxPending !== undefined && found[0].n >= maxPending) return 'full' as const
      if (quota && !(await this.sendAllowed(client, tenantId, subscriptionId, at, quota))) return 'rate' as const
      const { rows } = await client.query<DeliveryRow>(
        `INSERT INTO webhook_deliveries (id, tenant_id, subscription_id, event_id, event_type, body, created_at, next_attempt_at)
         SELECT ${NEW_DELIVERY_ID}, s.tenant_id, s.id, $3, $4, $5, coalesce($6::timestamptz, now()), coalesce($6::timestamptz, now()) FROM webhook_subscriptions s
         WHERE s.tenant_id = $1 AND s.id = $2
         ON CONFLICT (subscription_id, event_id) DO NOTHING RETURNING ${DELIVERY_COLUMNS}`,
        [tenantId, subscriptionId, eventId, eventType, body, at ?? null]
      )
      if (!rows[0]) return null
      if (quota) await this.countSend(client, tenantId, subscriptionId, at)
      return deliveryOf(rows[0])
    })
  }

  async claimWebhookDeliveries(limit: number, caps: WebhookClaimCaps, at?: WebhookClaimTime) {
    if (limit <= 0) return []
    const claim = randomBytes(12).toString('hex')
    return this.inTransaction(async client => {
      // Kept as the database writes them, to the microsecond: read into a Date (milliseconds), the time of the claim
      // would fall before a delivery queued in its last millisecond, left out of a claim it is due for (second review
      // 10b: one of two deliveries just queued claimed, 20 times in 300 on a fast database). Written in UTC (UTC_TEXT), not
      // as `::text`, which follows the session's DateStyle.
      const { rows: times } = await client.query<{ now: string; lease: string }>(
        `SELECT to_char(coalesce($1::timestamptz, now()) AT TIME ZONE 'UTC', '${UTC_TEXT}') AS now, to_char(coalesce($2::timestamptz, coalesce($1::timestamptz, now()) + $3 * interval '1 millisecond') AT TIME ZONE 'UTC', '${UTC_TEXT}') AS lease`,
        [at?.now ?? null, at?.leaseUntil ?? null, caps.leaseMs ?? 60_000]
      )
      const { now, lease } = times[0]!
      // The enabled subscriptions not paused that have a delivery due, and how many up to perSubscription: a few rows
      // of the index each, whatever waits behind them (a subscription with a thousand pending costs as much as one with
      // two).
      const { rows: ready } = await client.query<{ id: string; tenant_id: string; claimed_at: Timestamp | null; due: Timestamp; n: number }>(
        `SELECT s.id, s.tenant_id, s.claimed_at, f.due, f.n FROM webhook_subscriptions s
         CROSS JOIN LATERAL (
           SELECT min(x.next_attempt_at) AS due, count(*)::int AS n FROM (
             SELECT d.next_attempt_at FROM webhook_deliveries d
             WHERE d.subscription_id = s.id AND d.status = 'pending' AND d.next_attempt_at <= $1 AND d.attempts < $2
             ORDER BY d.next_attempt_at LIMIT $3
           ) x
         ) f
         WHERE f.n > 0 AND s.enabled AND (s.paused_until IS NULL OR s.paused_until <= $1)`,
        [now, caps.maxAttempts, caps.perSubscription]
      )
      if (!ready.length) return []
      const subs = ready.map(r => ({ id: r.id, tenantId: r.tenant_id, dueAt: iso(r.due), dueCount: r.n, ...(r.claimed_at ? { claimedAt: iso(r.claimed_at) } : {}) }))
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
        this.retried++
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
      await this.lockSubscriptionSends(client, subscriptionId)
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
      if (change.known && !before) return null
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
    // Its generation: one more for each lease taken (from another holder, or once it lapsed or was given back).
    const { rows } = await this.leasePool.query<{ write_from: Timestamp; write_until: Timestamp; generation: string }>(
      `INSERT INTO webhook_leases (role, holder, until, heard, write_from, write_until, generation)
       VALUES ($1, $2, now() + $3 * interval '1 millisecond', $4, now(), now() + ($3 - $5) * interval '1 millisecond', 1)
       ON CONFLICT (role) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until, heard = EXCLUDED.heard, write_until = EXCLUDED.write_until,
         write_from = CASE WHEN webhook_leases.holder = EXCLUDED.holder THEN webhook_leases.write_from
                           ELSE greatest(now(), least(webhook_leases.write_until, now()) + $5 * interval '1 millisecond') END,
         generation = CASE WHEN webhook_leases.holder = EXCLUDED.holder AND webhook_leases.until > now() THEN webhook_leases.generation
                           ELSE webhook_leases.generation + 1 END
       WHERE webhook_leases.holder = EXCLUDED.holder OR webhook_leases.until <= now() OR EXCLUDED.heard > webhook_leases.heard
       RETURNING write_from, write_until, generation`,
      [role, holder, ms, heard, margin]
    )
    return rows[0] ? { writeFrom: iso(rows[0].write_from), writeUntil: iso(rows[0].write_until), generation: Number(rows[0].generation) } : null
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
