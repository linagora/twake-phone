import {
  FRAUD_DEFAULTS,
  FRAUD_PARAMS,
  OUTBOUND_CAPS,
  TRUNK_OUTBOUND_CLASSES,
  type FraudRule,
  type OutboundAssignment,
  type OutboundCaps,
  type OutboundPolicy,
  type OutboundProfile
} from '@twake/telephony-types'
import type { Queryable } from './subscriber.js'

// The rules of the calls to the public network (step 6b, ADR 0017) in OpenSIPS's database. The Gateway keeps the
// policy, the rights profiles and who has which; this writes their projection: our `outbound_settings`,
// `outbound_profiles` and `outbound_users`, read with the trunk at each external call (route[trunk_out], through
// twake_outbound()), and the volume thresholds of OpenSIPS's `fraud_detection` module, which it loads at its start and
// on MI fraud_reload. Emergency calls are outside all of it: the script never asks.

/** Table versions OpenSIPS 3.6 checks in `version` (scripts/postgres/{fraud_detection,drouting}-create.sql). */
export const FRAUD_TABLE_VERSION = 1
export const DR_TABLE_VERSIONS = { dr_gateways: 6, dr_rules: 4, dr_carriers: 3, dr_groups: 2 } as const

/** The profile of `fraud_detection` the script checks every call against (check_fraud's third argument). */
export const FRAUD_PROFILE = 1
/** Its two rules: numbers in France (+33: prefix 33, the number without its +) and every other one (no prefix). */
export const FRAUD_RULE_NATIONAL = 1
export const FRAUD_RULE_INTERNATIONAL = 2

/** What a cap may be: a whole number of calls or minutes, at least 1. */
export const CAP_MAX = 1_000_000
/** No cap, as twake_outbound() says it: more than any count. */
export const NO_CAP_LEFT = 1_000_000_000

interface Projection {
  settings: unknown[]
  profiles: unknown[][]
  users: unknown[][]
  fraud: unknown[][]
}

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400, code: 'OUTBOUND_INVALID' })

export const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const USER_ID = /^[^\s\p{Cc}]{1,255}$/u
/** In byte order, as ORDER BY ... COLLATE "C" gives them back. */
const byId = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)

const capsRow = (caps: OutboundCaps | undefined, what: string) =>
  OUTBOUND_CAPS.map(k => {
    const v = caps?.[k]
    if (v === undefined || v === null) return 0
    if (!Number.isInteger(v) || v < 1 || v > CAP_MAX) throw invalid(`${what}: ${k} is a whole number from 1 to ${CAP_MAX}`)
    return v
  })

/** The thresholds of a rule as `fraud_detection` holds them, each absent one from FRAUD_DEFAULTS. */
export const fraudRow = (rule: FraudRule | undefined, defaults: FraudRule, what: string) =>
  FRAUD_PARAMS.flatMap(param => {
    const t = rule?.[param] ?? defaults[param] ?? {}
    return (['warning', 'critical'] as const).map(level => {
      const v = t[level] ?? 0
      if (!Number.isInteger(v) || v < 0 || v > CAP_MAX) throw invalid(`${what}: ${param}.${level} is a whole number from 0 (none) to ${CAP_MAX}`)
      return v
    })
  })

/**
 * Rows of the tables for this policy, these profiles and who has which; throws (400) on anything that could not go
 * into them: a profile id, a class no trunk knows, a cap, a profile named that does not exist.
 */
export const projectOutbound = (policy: OutboundPolicy, profiles: OutboundProfile[], assignments: OutboundAssignment[]): Projection => {
  const ids = new Set<string>()
  const out: Projection = { settings: [], profiles: [], users: [], fraud: [] }
  for (const p of profiles) {
    if (!PROFILE_ID.test(p.id)) throw invalid(`Profile id ${p.id} is not valid`)
    if (ids.has(p.id)) throw invalid(`Profile ${p.id} twice`)
    ids.add(p.id)
    if (!Array.isArray(p.allowed) || !p.allowed.every(c => (TRUNK_OUTBOUND_CLASSES as readonly string[]).includes(c))) throw invalid(`Profile ${p.id}: allowed is some of ${TRUNK_OUTBOUND_CLASSES.join(', ')}`)
    const allowed = TRUNK_OUTBOUND_CLASSES.filter(c => p.allowed.includes(c))
    out.profiles.push([p.id, `,${allowed.join(',')},`, ...capsRow(p.caps, `Profile ${p.id}`)])
  }
  out.profiles.sort((a, b) => byId(a[0], b[0]))
  const def = policy.defaultProfile ?? ''
  if (def && !ids.has(def)) throw invalid(`Default profile ${def}: no such profile`)
  out.settings = [def, ...capsRow(policy.caps, 'The organisation')]
  const users = new Set<string>()
  for (const a of assignments) {
    if (!USER_ID.test(a.userId)) throw invalid(`User id ${a.userId} is not valid`)
    if (!ids.has(a.profileId)) throw invalid(`User ${a.userId}: no profile ${a.profileId}`)
    if (users.has(a.userId)) throw invalid(`User ${a.userId} twice`)
    users.add(a.userId)
    out.users.push([a.userId, a.profileId])
  }
  out.users.sort((a, b) => byId(a[0], b[0]))
  out.fraud = [
    [FRAUD_RULE_NATIONAL, FRAUD_PROFILE, '33', ...fraudRow(policy.fraud?.national, FRAUD_DEFAULTS.national, 'National thresholds')],
    [FRAUD_RULE_INTERNATIONAL, FRAUD_PROFILE, '', ...fraudRow(policy.fraud?.international, FRAUD_DEFAULTS.international, 'International thresholds')]
  ]
  return out
}

/** The columns of `fraud_detection` in the order of fraudRow (FRAUD_PARAMS, warning then critical). */
const FRAUD_COLUMNS = ['cpm', 'total_calls', 'concurrent_calls', 'sequential_calls', 'call_duration'] as const
// FRAUD_PARAMS: callsPerMinute, dailyCalls, concurrentCalls, sequentialCalls, callSeconds.
const FRAUD_THRESHOLD_COLUMNS = FRAUD_COLUMNS.flatMap(c => [`${c}_warning`, `${c}_critical`])

/**
 * `outbound_settings`: the organisation's caps and its default profile ('' none), one row per tenant.
 * `outbound_profiles`: the rights profiles, `allowed` as `,fixed,mobile,` (`,,` internal calls only) and their caps
 * (0: none). `outbound_users`: the profile of each person an administrator gave one (`user_id`, the Gateway's user
 * id, as `subscriber.holder` holds it). `fraud_detection` and the four tables of `drouting`, which it needs loaded
 * (empty: no call is routed by it); its rules are the default thresholds (FRAUD_DEFAULTS) until the Gateway writes its
 * own. `twake_outbound(ext, tenant)`: what applies to a call of `ext`, one row: its
 * profile's `allowed` (NULL: no profile, the trunk's alone), the caps of calls at the same time (0: none), and what is
 * left of the others, today and this month, from the CDRs of calls to the public network (`acc.external` 'out';
 * answered calls, their duration): the least of the person's call caps and its name, the organisation's, and the
 * seconds left of the least of every minute cap, with its name and scope. NO_CAP_LEFT when none. The day and the
 * month are the database's (`localtimestamp`), as `acc.time` (OpenSIPS's clock): the same time zone for both.
 */
export const OUTBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS outbound_settings (
    tenant_id TEXT PRIMARY KEY NOT NULL,
    default_profile VARCHAR(32) DEFAULT '' NOT NULL,
    concurrent INTEGER DEFAULT 0 NOT NULL,
    daily_calls INTEGER DEFAULT 0 NOT NULL,
    daily_minutes INTEGER DEFAULT 0 NOT NULL,
    monthly_calls INTEGER DEFAULT 0 NOT NULL,
    monthly_minutes INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound_profiles (
    tenant_id TEXT DEFAULT '' NOT NULL,
    id VARCHAR(32) NOT NULL,
    allowed VARCHAR(128) DEFAULT ',,' NOT NULL,
    concurrent INTEGER DEFAULT 0 NOT NULL,
    daily_calls INTEGER DEFAULT 0 NOT NULL,
    daily_minutes INTEGER DEFAULT 0 NOT NULL,
    monthly_calls INTEGER DEFAULT 0 NOT NULL,
    monthly_minutes INTEGER DEFAULT 0 NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS outbound_users (
    tenant_id TEXT DEFAULT '' NOT NULL,
    user_id TEXT NOT NULL,
    profile_id VARCHAR(32) NOT NULL,
    PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS fraud_detection (
    ruleid SERIAL PRIMARY KEY NOT NULL,
    profileid INTEGER NOT NULL,
    prefix VARCHAR(64) NOT NULL,
    start_hour VARCHAR(5) DEFAULT '00:00' NOT NULL,
    end_hour VARCHAR(5) DEFAULT '23:59' NOT NULL,
    daysoftheweek VARCHAR(64) DEFAULT 'Mon-Sun' NOT NULL,
    cpm_warning INTEGER DEFAULT 0 NOT NULL,
    cpm_critical INTEGER DEFAULT 0 NOT NULL,
    call_duration_warning INTEGER DEFAULT 0 NOT NULL,
    call_duration_critical INTEGER DEFAULT 0 NOT NULL,
    total_calls_warning INTEGER DEFAULT 0 NOT NULL,
    total_calls_critical INTEGER DEFAULT 0 NOT NULL,
    concurrent_calls_warning INTEGER DEFAULT 0 NOT NULL,
    concurrent_calls_critical INTEGER DEFAULT 0 NOT NULL,
    sequential_calls_warning INTEGER DEFAULT 0 NOT NULL,
    sequential_calls_critical INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS dr_gateways (
    id SERIAL PRIMARY KEY NOT NULL,
    gwid VARCHAR(64) NOT NULL,
    type INTEGER DEFAULT 0 NOT NULL,
    address VARCHAR(128) NOT NULL,
    strip INTEGER DEFAULT 0 NOT NULL,
    pri_prefix VARCHAR(16) DEFAULT NULL,
    attrs VARCHAR(255) DEFAULT NULL,
    probe_mode INTEGER DEFAULT 0 NOT NULL,
    state INTEGER DEFAULT 0 NOT NULL,
    socket VARCHAR(128) DEFAULT NULL,
    description VARCHAR(128) DEFAULT NULL,
    CONSTRAINT dr_gateways_dr_gw_idx UNIQUE (gwid)
);
CREATE TABLE IF NOT EXISTS dr_rules (
    ruleid SERIAL PRIMARY KEY NOT NULL,
    groupid VARCHAR(255) NOT NULL,
    prefix VARCHAR(64) NOT NULL,
    timerec VARCHAR(255) DEFAULT NULL,
    priority INTEGER DEFAULT 0 NOT NULL,
    routeid VARCHAR(255) DEFAULT NULL,
    gwlist VARCHAR(255),
    sort_alg VARCHAR(1) DEFAULT 'N' NOT NULL,
    sort_profile INTEGER DEFAULT NULL,
    attrs VARCHAR(255) DEFAULT NULL,
    description VARCHAR(128) DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS dr_carriers (
    id SERIAL PRIMARY KEY NOT NULL,
    carrierid VARCHAR(64) NOT NULL,
    gwlist VARCHAR(255) NOT NULL,
    flags INTEGER DEFAULT 0 NOT NULL,
    sort_alg VARCHAR(1) DEFAULT 'N' NOT NULL,
    state INTEGER DEFAULT 0 NOT NULL,
    attrs VARCHAR(255) DEFAULT NULL,
    description VARCHAR(128) DEFAULT NULL,
    CONSTRAINT dr_carriers_dr_carrier_idx UNIQUE (carrierid)
);
CREATE TABLE IF NOT EXISTS dr_groups (
    id SERIAL PRIMARY KEY NOT NULL,
    username VARCHAR(64) NOT NULL,
    domain VARCHAR(128) DEFAULT NULL,
    groupid INTEGER DEFAULT 0 NOT NULL,
    description VARCHAR(128) DEFAULT NULL
);
INSERT INTO version (table_name, table_version) VALUES ('fraud_detection', ${FRAUD_TABLE_VERSION}), ${Object.entries(DR_TABLE_VERSIONS)
  .map(([t, v]) => `('${t}', ${v})`)
  .join(', ')}
  ON CONFLICT (table_name) DO NOTHING;
INSERT INTO fraud_detection (ruleid, profileid, prefix, ${FRAUD_THRESHOLD_COLUMNS.join(', ')}) VALUES
${projectOutbound({}, [], []).fraud.map(r => `  (${r.map(v => (typeof v === 'string' ? `'${v}'` : v)).join(', ')})`).join(',\n')}
  ON CONFLICT (ruleid) DO NOTHING;
SET check_function_bodies = false;
CREATE OR REPLACE FUNCTION twake_outbound(ext TEXT, tenant TEXT)
RETURNS TABLE (allowed TEXT, user_concurrent INTEGER, tenant_concurrent INTEGER, user_calls_left INTEGER, user_calls_param TEXT, tenant_calls_left INTEGER, tenant_calls_param TEXT, seconds_left INTEGER, seconds_param TEXT, seconds_scope TEXT)
LANGUAGE sql STABLE AS $twake$
WITH s AS (SELECT * FROM outbound_settings WHERE tenant_id = tenant),
p AS (
  SELECT pr.* FROM s JOIN outbound_profiles pr ON pr.tenant_id = s.tenant_id AND pr.id = coalesce(
    (SELECT ou.profile_id FROM outbound_users ou JOIN subscriber sb ON sb.holder = ou.user_id WHERE ou.tenant_id = tenant AND sb.username = ext LIMIT 1),
    nullif(s.default_profile, ''))
),
u AS (
  SELECT
    count(*) FILTER (WHERE a.caller = ext AND a.time >= date_trunc('day', localtimestamp))::int AS user_day_calls,
    count(*) FILTER (WHERE a.caller = ext)::int AS user_month_calls,
    coalesce(sum(a.duration) FILTER (WHERE a.caller = ext AND a.time >= date_trunc('day', localtimestamp)), 0)::int AS user_day_sec,
    coalesce(sum(a.duration) FILTER (WHERE a.caller = ext), 0)::int AS user_month_sec,
    count(*) FILTER (WHERE a.time >= date_trunc('day', localtimestamp))::int AS day_calls,
    count(*)::int AS month_calls,
    coalesce(sum(a.duration) FILTER (WHERE a.time >= date_trunc('day', localtimestamp)), 0)::int AS day_sec,
    coalesce(sum(a.duration), 0)::int AS month_sec
  FROM acc a WHERE a.external = 'out' AND a.time >= date_trunc('month', localtimestamp) AND EXISTS (SELECT 1 FROM s)
),
c (scope, param, unit, left_) AS (
  SELECT 'user', 'dailyCalls', 'calls', p.daily_calls - u.user_day_calls FROM p, u WHERE p.daily_calls > 0
  UNION ALL SELECT 'user', 'monthlyCalls', 'calls', p.monthly_calls - u.user_month_calls FROM p, u WHERE p.monthly_calls > 0
  UNION ALL SELECT 'user', 'dailyMinutes', 'seconds', p.daily_minutes * 60 - u.user_day_sec FROM p, u WHERE p.daily_minutes > 0
  UNION ALL SELECT 'user', 'monthlyMinutes', 'seconds', p.monthly_minutes * 60 - u.user_month_sec FROM p, u WHERE p.monthly_minutes > 0
  UNION ALL SELECT 'tenant', 'dailyCalls', 'calls', s.daily_calls - u.day_calls FROM s, u WHERE s.daily_calls > 0
  UNION ALL SELECT 'tenant', 'monthlyCalls', 'calls', s.monthly_calls - u.month_calls FROM s, u WHERE s.monthly_calls > 0
  UNION ALL SELECT 'tenant', 'dailyMinutes', 'seconds', s.daily_minutes * 60 - u.day_sec FROM s, u WHERE s.daily_minutes > 0
  UNION ALL SELECT 'tenant', 'monthlyMinutes', 'seconds', s.monthly_minutes * 60 - u.month_sec FROM s, u WHERE s.monthly_minutes > 0
),
uc AS (SELECT * FROM c WHERE scope = 'user' AND unit = 'calls' ORDER BY left_ LIMIT 1),
tc AS (SELECT * FROM c WHERE scope = 'tenant' AND unit = 'calls' ORDER BY left_ LIMIT 1),
sc AS (SELECT * FROM c WHERE unit = 'seconds' ORDER BY left_, scope DESC LIMIT 1)
SELECT
  (SELECT p.allowed FROM p)::text,
  coalesce((SELECT p.concurrent FROM p), 0),
  coalesce((SELECT s.concurrent FROM s), 0),
  coalesce((SELECT left_ FROM uc), ${NO_CAP_LEFT}), coalesce((SELECT param FROM uc), ''),
  coalesce((SELECT left_ FROM tc), ${NO_CAP_LEFT}), coalesce((SELECT param FROM tc), ''),
  coalesce((SELECT left_ FROM sc), ${NO_CAP_LEFT}), coalesce((SELECT param FROM sc), ''), coalesce((SELECT scope FROM sc), '')
$twake$;
RESET check_function_bodies;
`

/**
 * The column `acc` gains for the caps (`external`: 'out' for a call to the public network, 'emergency' for an
 * emergency call, which counts for nothing; `missed_calls` too, acc writes its extras in both) and the index their
 * reads take. On a database created before step 6b,
 * before OpenSIPS starts (docker/opensips/trunk.sql: OpenSIPS writes the column in every CDR), where it lacks only:
 * no lock is taken on `acc` otherwise.
 */
export const ACC_EXTERNAL_SQL = `DO $twake$
BEGIN
  IF to_regclass('acc') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'acc' AND column_name = 'external') THEN
    ALTER TABLE acc ADD COLUMN external VARCHAR(64) DEFAULT '' NOT NULL;
  END IF;
  IF to_regclass('missed_calls') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'missed_calls' AND column_name = 'external') THEN
    ALTER TABLE missed_calls ADD COLUMN external VARCHAR(64) DEFAULT '' NOT NULL;
  END IF;
  IF to_regclass('acc') IS NOT NULL AND to_regclass('acc_external_idx') IS NULL THEN
    CREATE INDEX acc_external_idx ON acc (external, time);
  END IF;
END
$twake$;
`

export interface OutboundTablesOptions {
  pool: Queryable
  /** Awaited before each query: the schema check of the provider. */
  ready?: () => Promise<void>
  tenantId?: string
}

const sameRows = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Writes the tenant's projection; says whether the thresholds changed (the provider then asks for fraud_reload). */
export class OutboundTables {
  private readonly tenantId: string

  constructor(private readonly opts: OutboundTablesOptions) {
    this.tenantId = opts.tenantId ?? 'default'
  }

  private async current(q: Queryable): Promise<Projection> {
    const rows = async (text: string, values: unknown[] = [this.tenantId]) => (((await q.query(text, values)) as { rows?: Record<string, unknown>[] } | undefined)?.rows ?? []).map(r => Object.values(r))
    return {
      settings: (await rows('SELECT default_profile, concurrent, daily_calls, daily_minutes, monthly_calls, monthly_minutes FROM outbound_settings WHERE tenant_id = $1'))[0] ?? [],
      profiles: await rows('SELECT id, allowed, concurrent, daily_calls, daily_minutes, monthly_calls, monthly_minutes FROM outbound_profiles WHERE tenant_id = $1 ORDER BY id COLLATE "C"'),
      users: await rows('SELECT user_id, profile_id FROM outbound_users WHERE tenant_id = $1 ORDER BY user_id COLLATE "C"'),
      fraud: await rows(`SELECT ruleid, profileid, prefix, ${FRAUD_THRESHOLD_COLUMNS.join(', ')} FROM fraud_detection ORDER BY ruleid`, [])
    }
  }

  /**
   * Exactly this policy, these profiles and assignments for the tenant, in one transaction; nothing written when the
   * database holds them already. Refused (409) when another tenant has a policy in this database: OpenSIPS reads one
   * set of thresholds.
   */
  async set(policy: OutboundPolicy, profiles: OutboundProfile[], assignments: OutboundAssignment[]): Promise<{ fraud: boolean }> {
    const wanted = projectOutbound(policy, profiles, assignments)
    await this.opts.ready?.()
    const client = this.opts.pool.connect ? await this.opts.pool.connect() : undefined
    const q = client ?? this.opts.pool
    try {
      await q.query('BEGIN')
      await q.query('LOCK TABLE outbound_settings IN SHARE ROW EXCLUSIVE MODE')
      const other = (await q.query('SELECT tenant_id FROM outbound_settings WHERE tenant_id <> $1 LIMIT 1', [this.tenantId])) as { rows?: unknown[] } | undefined
      if (other?.rows?.length) throw Object.assign(new Error("OpenSIPS's database holds the outbound policy of another tenant: one tenant per database"), { statusCode: 409, code: 'OUTBOUND_OTHER_TENANT' })
      const now = await this.current(q)
      const changed = { fraud: !sameRows(now.fraud, wanted.fraud) }
      if (!changed.fraud && sameRows(now.settings, wanted.settings) && sameRows(now.profiles, wanted.profiles) && sameRows(now.users, wanted.users)) {
        await q.query('COMMIT')
        return changed
      }
      await q.query('DELETE FROM outbound_users WHERE tenant_id = $1', [this.tenantId])
      await q.query('DELETE FROM outbound_profiles WHERE tenant_id = $1', [this.tenantId])
      await q.query(
        'INSERT INTO outbound_settings (tenant_id, default_profile, concurrent, daily_calls, daily_minutes, monthly_calls, monthly_minutes) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id) DO UPDATE SET default_profile = EXCLUDED.default_profile, concurrent = EXCLUDED.concurrent, daily_calls = EXCLUDED.daily_calls, daily_minutes = EXCLUDED.daily_minutes, monthly_calls = EXCLUDED.monthly_calls, monthly_minutes = EXCLUDED.monthly_minutes',
        [this.tenantId, ...wanted.settings]
      )
      for (const r of wanted.profiles) await q.query('INSERT INTO outbound_profiles (tenant_id, id, allowed, concurrent, daily_calls, daily_minutes, monthly_calls, monthly_minutes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [this.tenantId, ...r])
      if (wanted.users.length)
        await q.query('INSERT INTO outbound_users (tenant_id, user_id, profile_id) SELECT $1, u, p FROM unnest($2::text[], $3::text[]) AS w(u, p)', [this.tenantId, wanted.users.map(r => r[0]), wanted.users.map(r => r[1])])
      if (changed.fraud) {
        await q.query('DELETE FROM fraud_detection')
        for (const r of wanted.fraud)
          await q.query(
            `INSERT INTO fraud_detection (ruleid, profileid, prefix, ${FRAUD_THRESHOLD_COLUMNS.join(', ')}) VALUES (${r.map((_, i) => `$${i + 1}`).join(', ')})`,
            r
          )
      }
      await q.query('COMMIT')
      return changed
    } catch (err) {
      await q.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client?.release()
    }
  }
}
