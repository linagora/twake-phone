import {
  FRAUD_DEFAULTS,
  FRAUD_PARAMS,
  OUTBOUND_CAP_DEFAULTS,
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
// `outbound_profiles` and `outbound_users`, read at each external call by twake_outbound() (route[outbound_loaded], a
// query of its own after the trunk's), and the volume thresholds of OpenSIPS's `fraud_detection` module, which it
// loads at its start and on MI fraud_reload. What was used is kept as it goes (`outbound_usage`, from the CDRs, by a
// trigger on `acc`), never read from the CDRs during a call. Emergency calls are outside all of it: the script never
// asks.

/** Table versions OpenSIPS 3.6 checks in `version` (scripts/postgres/{fraud_detection,drouting,dialog}-create.sql). */
export const FRAUD_TABLE_VERSION = 1
export const DR_TABLE_VERSIONS = { dr_gateways: 6, dr_rules: 4, dr_carriers: 3, dr_groups: 2 } as const
export const DIALOG_TABLE_VERSION = 12

/** The profile of `fraud_detection` the script checks every call against (check_fraud's third argument). */
export const FRAUD_PROFILE = 1
/** Its rules: numbers in France (+33: prefix 33, the number without its +) and every other one (no prefix). */
export const FRAUD_RULE_NATIONAL = 1
export const FRAUD_RULE_INTERNATIONAL = 2
/**
 * The French overseas numbers of the French plan (numbering.ts, `overseas`: +33 262, 263, 269, 590, 594, 596, 639, 690
 * to 697, 976), each a rule of its own (rule ids from 3, in this order) with the international thresholds: the same
 * number dialled 0262... or +262... is held to the same thresholds.
 */
export const FRAUD_OVERSEAS_PREFIXES = ['33262', '33263', '33269', '33590', '33594', '33596', '33639', '33690', '33691', '33692', '33693', '33694', '33695', '33696', '33697', '33976'] as const

/** What a cap may be: a whole number of calls or minutes, at least 1. */
export const CAP_MAX = 1_000_000
/** The time zone of the days and months of the caps, whatever the servers' own. */
export const OUTBOUND_TIME_ZONE = 'Europe/Paris'

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

/** The caps as the tables hold them (0: none): each one absent takes its default, `null` none. */
const capsRow = (caps: OutboundCaps | undefined, defaults: OutboundCaps, what: string) =>
  OUTBOUND_CAPS.map(k => {
    const v = caps?.[k] === undefined ? defaults[k] : caps[k]
    if (v === undefined || v === null) return 0
    if (!Number.isInteger(v) || v < 1 || v > CAP_MAX) throw invalid(`${what}: ${k} is a whole number from 1 to ${CAP_MAX}, or null (no cap)`)
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
    out.profiles.push([p.id, `,${allowed.join(',')},`, ...capsRow(p.caps, OUTBOUND_CAP_DEFAULTS.user, `Profile ${p.id}`)])
  }
  out.profiles.sort((a, b) => byId(a[0], b[0]))
  const def = policy.defaultProfile ?? ''
  if (def && !ids.has(def)) throw invalid(`Default profile ${def}: no such profile`)
  out.settings = [def, ...capsRow(policy.caps, OUTBOUND_CAP_DEFAULTS.tenant, 'The organisation'), ...capsRow(policy.userCaps, OUTBOUND_CAP_DEFAULTS.user, 'Those without a profile')]
  const users = new Set<string>()
  for (const a of assignments) {
    if (!USER_ID.test(a.userId)) throw invalid(`User id ${a.userId} is not valid`)
    if (!ids.has(a.profileId)) throw invalid(`User ${a.userId}: no profile ${a.profileId}`)
    if (users.has(a.userId)) throw invalid(`User ${a.userId} twice`)
    users.add(a.userId)
    out.users.push([a.userId, a.profileId])
  }
  out.users.sort((a, b) => byId(a[0], b[0]))
  const international = fraudRow(policy.fraud?.international, FRAUD_DEFAULTS.international, 'International thresholds')
  out.fraud = [
    [FRAUD_RULE_NATIONAL, FRAUD_PROFILE, '33', ...fraudRow(policy.fraud?.national, FRAUD_DEFAULTS.national, 'National thresholds')],
    [FRAUD_RULE_INTERNATIONAL, FRAUD_PROFILE, '', ...international],
    ...FRAUD_OVERSEAS_PREFIXES.map((prefix, i) => [FRAUD_RULE_INTERNATIONAL + 1 + i, FRAUD_PROFILE, prefix, ...international])
  ]
  return out
}

/** The columns of `fraud_detection` in the order of fraudRow (FRAUD_PARAMS, warning then critical). */
const FRAUD_COLUMNS = ['cpm', 'total_calls', 'concurrent_calls', 'sequential_calls', 'call_duration'] as const
// FRAUD_PARAMS: callsPerMinute, dailyAttempts, concurrentCalls, sequentialCalls, callSeconds.
const FRAUD_THRESHOLD_COLUMNS = FRAUD_COLUMNS.flatMap(c => [`${c}_warning`, `${c}_critical`])

/** The caps of a scope before its Gateway wrote anything, in the order of OUTBOUND_CAPS (0: none). */
const defaultCapsSql = (caps: OutboundCaps) => `ARRAY[${OUTBOUND_CAPS.map(k => caps[k] ?? 0).join(', ')}]`
/** A key of pg_advisory_xact_lock that nothing else takes: the minute caps are shared out one call at a time. */
const ALLOT_LOCK = 60170017

/**
 * `outbound_settings`: the organisation's default profile ('' none), its caps and the caps of those without a profile
 * (0: none), one row per tenant. `outbound_profiles`: the rights profiles, `allowed` as `,fixed,mobile,` (`,,` internal
 * calls only) and their caps (0: none). `outbound_users`: the profile of each person an administrator gave one
 * (`user_id`, the Gateway's user id, as `subscriber.holder` holds it). Every cap there is the effective one, defaults
 * applied (OUTBOUND_CAP_DEFAULTS); with no row at all (a Gateway that never wrote), the defaults hold all the same.
 *
 * `outbound_usage`: what was used, per extension (`scope` user, `subject` the extension) and for the whole database
 * (`tenant`, subject ''), per day ('d') and per month ('m', `start` its first day), in Europe/Paris whatever the
 * servers' time zone: answered calls and their seconds, added by twake_outbound_cdr() as each CDR of a call to the
 * public network is written (`acc.external` 'out'). Kept two months. `outbound_reservations`: the seconds allotted to
 * each call in progress under a minute cap (`call_key` md5 of its Call-ID), released when its CDR or its missed call
 * is written, else when `until` passes (a call that never ended, OpenSIPS gone).
 *
 * `twake_outbound(ext, class, number, user_active, tenant_active, call_key, max_sec, min_sec)`: what applies to a call
 * of `ext` to `number` (E.164 without its +) of `class`, with `user_active` and `tenant_active` the calls to the public
 * network in progress counted with it (the dialog profiles, under a lock). One row: `verdict` ok, `rights` (the class
 * is not in the caller's profile; `reason` the class), or `limit` (`reason` the cap and `reason_scope` user or tenant);
 * and `max_sec`, how long the call may last: the least of `max_sec`, its share of what is left of every minute cap
 * (what is left divided by the calls that may still be placed at once, this one included, per the concurrency cap of
 * the same scope; all of it without one), reserved for it, and the critical duration of the thresholds of its number.
 * A share under `min_sec` refuses the call. The day and the month are those of Europe/Paris.
 *
 * `fraud_detection` and the four tables of `drouting`, which it needs loaded (empty: no call is routed by it); its rules
 * are the default thresholds (FRAUD_DEFAULTS) until the Gateway writes its own. `dialog`: the calls in progress, which
 * OpenSIPS writes there (dialog's db_mode 2) and reads back at its start: their timers, their CDR and the dialog
 * profiles the caps count survive a restart.
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
ALTER TABLE outbound_settings ADD COLUMN IF NOT EXISTS user_concurrent INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE outbound_settings ADD COLUMN IF NOT EXISTS user_daily_calls INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE outbound_settings ADD COLUMN IF NOT EXISTS user_daily_minutes INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE outbound_settings ADD COLUMN IF NOT EXISTS user_monthly_calls INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE outbound_settings ADD COLUMN IF NOT EXISTS user_monthly_minutes INTEGER DEFAULT 0 NOT NULL;
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
CREATE TABLE IF NOT EXISTS outbound_usage (
    scope VARCHAR(8) NOT NULL,
    subject VARCHAR(64) NOT NULL,
    period CHAR(1) NOT NULL,
    start DATE NOT NULL,
    calls INTEGER DEFAULT 0 NOT NULL,
    seconds BIGINT DEFAULT 0 NOT NULL,
    PRIMARY KEY (scope, subject, period, start)
);
CREATE TABLE IF NOT EXISTS outbound_reservations (
    call_key VARCHAR(32) PRIMARY KEY NOT NULL,
    subject VARCHAR(64) NOT NULL,
    seconds INTEGER NOT NULL,
    until TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS outbound_reservations_until_idx ON outbound_reservations (until);
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
CREATE TABLE IF NOT EXISTS dialog (
    dlg_id BIGINT PRIMARY KEY NOT NULL,
    callid VARCHAR(255) NOT NULL,
    from_uri VARCHAR(255) NOT NULL,
    from_tag VARCHAR(64) NOT NULL,
    to_uri VARCHAR(255) NOT NULL,
    to_tag VARCHAR(64) NOT NULL,
    mangled_from_uri VARCHAR(255) DEFAULT NULL,
    mangled_to_uri VARCHAR(255) DEFAULT NULL,
    caller_cseq VARCHAR(11) NOT NULL,
    callee_cseq VARCHAR(11) NOT NULL,
    caller_ping_cseq INTEGER NOT NULL,
    callee_ping_cseq INTEGER NOT NULL,
    caller_route_set TEXT,
    callee_route_set TEXT,
    caller_contact VARCHAR(255),
    callee_contact VARCHAR(255),
    caller_sock VARCHAR(64) NOT NULL,
    callee_sock VARCHAR(64) NOT NULL,
    state INTEGER NOT NULL,
    start_time INTEGER NOT NULL,
    timeout INTEGER NOT NULL,
    vars BYTEA DEFAULT NULL,
    profiles TEXT DEFAULT NULL,
    script_flags VARCHAR(255) DEFAULT NULL,
    module_flags INTEGER DEFAULT 0 NOT NULL,
    flags INTEGER DEFAULT 0 NOT NULL,
    rt_on_answer VARCHAR(64) DEFAULT NULL,
    rt_on_timeout VARCHAR(64) DEFAULT NULL,
    rt_on_hangup VARCHAR(64) DEFAULT NULL
);
INSERT INTO version (table_name, table_version) VALUES ('fraud_detection', ${FRAUD_TABLE_VERSION}), ${Object.entries(DR_TABLE_VERSIONS)
  .map(([t, v]) => `('${t}', ${v})`)
  .join(', ')}, ('dialog', ${DIALOG_TABLE_VERSION})
  ON CONFLICT (table_name) DO NOTHING;
INSERT INTO fraud_detection (ruleid, profileid, prefix, ${FRAUD_THRESHOLD_COLUMNS.join(', ')}) VALUES
${projectOutbound({}, [], []).fraud.map(r => `  (${r.map(v => (typeof v === 'string' ? `'${v}'` : v)).join(', ')})`).join(',\n')}
  ON CONFLICT (ruleid) DO NOTHING;
DROP FUNCTION IF EXISTS twake_outbound(TEXT, TEXT);
SET check_function_bodies = false;
CREATE OR REPLACE FUNCTION twake_outbound(p_ext TEXT, p_class TEXT, p_number TEXT, p_user_active INTEGER, p_tenant_active INTEGER, p_key TEXT, p_max INTEGER, p_min INTEGER)
RETURNS TABLE (verdict TEXT, reason TEXT, reason_scope TEXT, max_sec INTEGER)
LANGUAGE plpgsql VOLATILE AS $twake$
#variable_conflict use_column
DECLARE
  st outbound_settings%ROWTYPE;
  rights TEXT;
  uc INTEGER[] := ${defaultCapsSql(OUTBOUND_CAP_DEFAULTS.user)};
  tc INTEGER[] := ${defaultCapsSql(OUTBOUND_CAP_DEFAULTS.tenant)};
  pc INTEGER[];
  today DATE := (now() AT TIME ZONE '${OUTBOUND_TIME_ZONE}')::date;
  month DATE := date_trunc('month', now() AT TIME ZONE '${OUTBOUND_TIME_ZONE}')::date;
  u_dc BIGINT; u_ds BIGINT; u_mc BIGINT; u_ms BIGINT;
  t_dc BIGINT; t_ds BIGINT; t_mc BIGINT; t_ms BIGINT;
  r_user BIGINT; r_tenant BIGINT;
  allot BIGINT := p_max;
  share BIGINT;
  slots BIGINT;
  why TEXT := '';
  why_scope TEXT := '';
  dur INTEGER;
  i INTEGER;
  caps INTEGER[];
  used BIGINT[];
  reserved BIGINT[];
  conc INTEGER[];
  active INTEGER[];
  names TEXT[] := ARRAY['dailyMinutes', 'monthlyMinutes', 'dailyMinutes', 'monthlyMinutes'];
  scopes TEXT[] := ARRAY['user', 'user', 'tenant', 'tenant'];
BEGIN
  SELECT * INTO st FROM outbound_settings LIMIT 1;
  IF FOUND THEN
    tc := ARRAY[st.concurrent, st.daily_calls, st.daily_minutes, st.monthly_calls, st.monthly_minutes];
    uc := ARRAY[st.user_concurrent, st.user_daily_calls, st.user_daily_minutes, st.user_monthly_calls, st.user_monthly_minutes];
    SELECT pr.allowed, ARRAY[pr.concurrent, pr.daily_calls, pr.daily_minutes, pr.monthly_calls, pr.monthly_minutes] INTO rights, pc
      FROM outbound_profiles pr WHERE pr.tenant_id = st.tenant_id AND pr.id = coalesce(
        (SELECT ou.profile_id FROM outbound_users ou JOIN subscriber sb ON sb.holder = ou.user_id WHERE ou.tenant_id = st.tenant_id AND sb.username = p_ext LIMIT 1),
        nullif(st.default_profile, ''));
    IF FOUND THEN
      uc := pc;
    END IF;
  END IF;
  IF rights IS NOT NULL AND position(',' || p_class || ',' IN rights) = 0 THEN
    RETURN QUERY SELECT 'rights'::text, p_class, 'user'::text, 0;
    RETURN;
  END IF;
  IF uc[1] > 0 AND p_user_active > uc[1] THEN
    RETURN QUERY SELECT 'limit'::text, 'concurrent'::text, 'user'::text, 0;
    RETURN;
  END IF;
  IF tc[1] > 0 AND p_tenant_active > tc[1] THEN
    RETURN QUERY SELECT 'limit'::text, 'concurrent'::text, 'tenant'::text, 0;
    RETURN;
  END IF;
  SELECT coalesce(sum(u.calls) FILTER (WHERE u.period = 'd'), 0), coalesce(sum(u.seconds) FILTER (WHERE u.period = 'd'), 0), coalesce(sum(u.calls) FILTER (WHERE u.period = 'm'), 0), coalesce(sum(u.seconds) FILTER (WHERE u.period = 'm'), 0)
    INTO u_dc, u_ds, u_mc, u_ms FROM outbound_usage u WHERE u.scope = 'user' AND u.subject = p_ext AND ((u.period = 'd' AND u.start = today) OR (u.period = 'm' AND u.start = month));
  SELECT coalesce(sum(u.calls) FILTER (WHERE u.period = 'd'), 0), coalesce(sum(u.seconds) FILTER (WHERE u.period = 'd'), 0), coalesce(sum(u.calls) FILTER (WHERE u.period = 'm'), 0), coalesce(sum(u.seconds) FILTER (WHERE u.period = 'm'), 0)
    INTO t_dc, t_ds, t_mc, t_ms FROM outbound_usage u WHERE u.scope = 'tenant' AND u.subject = '' AND ((u.period = 'd' AND u.start = today) OR (u.period = 'm' AND u.start = month));
  -- Answered calls of the period, and the calls in progress (this one counted).
  IF uc[2] > 0 AND u_dc + p_user_active > uc[2] THEN
    RETURN QUERY SELECT 'limit'::text, 'dailyCalls'::text, 'user'::text, 0;
    RETURN;
  END IF;
  IF uc[4] > 0 AND u_mc + p_user_active > uc[4] THEN
    RETURN QUERY SELECT 'limit'::text, 'monthlyCalls'::text, 'user'::text, 0;
    RETURN;
  END IF;
  IF tc[2] > 0 AND t_dc + p_tenant_active > tc[2] THEN
    RETURN QUERY SELECT 'limit'::text, 'dailyCalls'::text, 'tenant'::text, 0;
    RETURN;
  END IF;
  IF tc[4] > 0 AND t_mc + p_tenant_active > tc[4] THEN
    RETURN QUERY SELECT 'limit'::text, 'monthlyCalls'::text, 'tenant'::text, 0;
    RETURN;
  END IF;
  IF uc[3] > 0 OR uc[5] > 0 OR tc[3] > 0 OR tc[5] > 0 THEN
    -- One call at a time shares the minutes out: what the others hold is known.
    PERFORM pg_advisory_xact_lock(${ALLOT_LOCK});
    SELECT coalesce(sum(r.seconds) FILTER (WHERE r.subject = p_ext), 0), coalesce(sum(r.seconds), 0) INTO r_user, r_tenant
      FROM outbound_reservations r WHERE r.until > now() AND r.call_key <> p_key;
    caps := ARRAY[uc[3], uc[5], tc[3], tc[5]];
    used := ARRAY[u_ds, u_ms, t_ds, t_ms];
    reserved := ARRAY[r_user, r_user, r_tenant, r_tenant];
    conc := ARRAY[uc[1], uc[1], tc[1], tc[1]];
    active := ARRAY[p_user_active, p_user_active, p_tenant_active, p_tenant_active];
    FOR i IN 1..4 LOOP
      IF caps[i] > 0 THEN
        slots := 1;
        IF conc[i] > 0 THEN
          slots := greatest(1, conc[i] - (active[i] - 1));
        END IF;
        share := floor((caps[i]::bigint * 60 - used[i] - reserved[i])::numeric / slots);
        IF share < allot THEN
          allot := share;
          why := names[i];
          why_scope := scopes[i];
        END IF;
      END IF;
    END LOOP;
    IF allot < p_min THEN
      RETURN QUERY SELECT 'limit'::text, why, why_scope, 0;
      RETURN;
    END IF;
    INSERT INTO outbound_reservations AS r (call_key, subject, seconds, until) VALUES (p_key, p_ext, allot, now() + make_interval(secs => allot + 300))
      ON CONFLICT (call_key) DO UPDATE SET subject = EXCLUDED.subject, seconds = EXCLUDED.seconds, until = EXCLUDED.until;
  END IF;
  -- The critical duration of the thresholds of this number (the longest prefix, as fraud_detection matches it).
  SELECT f.call_duration_critical INTO dur FROM fraud_detection f WHERE f.profileid = ${FRAUD_PROFILE} AND p_number LIKE f.prefix || '%' ORDER BY length(f.prefix) DESC LIMIT 1;
  IF dur > 0 AND dur < allot THEN
    allot := dur;
  END IF;
  RETURN QUERY SELECT 'ok'::text, why, why_scope, allot::integer;
END
$twake$;
CREATE OR REPLACE FUNCTION twake_outbound_cdr() RETURNS trigger
LANGUAGE plpgsql AS $twake$
#variable_conflict use_column
DECLARE
  d DATE;
  m DATE;
  secs BIGINT;
  who TEXT;
BEGIN
  -- Never a CDR lost for this: whatever fails here is only logged.
  BEGIN
    DELETE FROM outbound_reservations r WHERE r.call_key = md5(NEW.callid);
    IF TG_TABLE_NAME = 'acc' THEN
      secs := greatest(coalesce(NEW.duration, 0), 0);
      who := coalesce(NEW.caller, '');
      -- The day the call was answered, in Europe/Paris: the CDR is written at its end.
      d := ((now() - make_interval(secs => secs)) AT TIME ZONE '${OUTBOUND_TIME_ZONE}')::date;
      m := date_trunc('month', d)::date;
      -- The first CDR of a day: what is two months old goes, with the reservations past.
      IF NOT EXISTS (SELECT 1 FROM outbound_usage u WHERE u.scope = 'tenant' AND u.subject = '' AND u.period = 'd' AND u.start = d) THEN
        DELETE FROM outbound_usage u WHERE u.start < (m - interval '1 month');
        DELETE FROM outbound_reservations r WHERE r.until < now();
      END IF;
      INSERT INTO outbound_usage AS u (scope, subject, period, start, calls, seconds) VALUES
        ('user', who, 'd', d, 1, secs), ('user', who, 'm', m, 1, secs), ('tenant', '', 'd', d, 1, secs), ('tenant', '', 'm', m, 1, secs)
        ON CONFLICT (scope, subject, period, start) DO UPDATE SET calls = u.calls + 1, seconds = u.seconds + EXCLUDED.seconds;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'twake_outbound_cdr: %', SQLERRM;
  END;
  RETURN NULL;
END
$twake$;
RESET check_function_bodies;
`

/**
 * The column `acc` and `missed_calls` gain for the caps (`external`: 'out' for a call to the public network, 'emergency'
 * for an emergency call, which counts for nothing; acc writes its extras in both), on a database created before step
 * 6b, and the triggers that count what was used as each CDR is written (twake_outbound_cdr()): only where they lack,
 * so that no lock is taken on `acc` otherwise, and never waiting more than 5 s for one (OpenSIPS writes its CDRs in
 * its SIP processes: a lock held long would hold the calls). Run by docker/opensips/trunk.sql before OpenSIPS starts,
 * and by the provider at its start. No index on `acc`: nothing reads it during a call.
 */
export const ACC_EXTERNAL_SQL = `BEGIN;
SET LOCAL lock_timeout = '5s';
DO $twake$
BEGIN
  IF to_regclass('acc') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'acc' AND column_name = 'external') THEN
    ALTER TABLE acc ADD COLUMN external VARCHAR(64) DEFAULT '' NOT NULL;
  END IF;
  IF to_regclass('missed_calls') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'missed_calls' AND column_name = 'external') THEN
    ALTER TABLE missed_calls ADD COLUMN external VARCHAR(64) DEFAULT '' NOT NULL;
  END IF;
  IF to_regclass('acc') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'twake_outbound_acc' AND tgrelid = to_regclass('acc')) THEN
    CREATE TRIGGER twake_outbound_acc AFTER INSERT ON acc FOR EACH ROW WHEN (NEW.external = 'out') EXECUTE FUNCTION twake_outbound_cdr();
  END IF;
  IF to_regclass('missed_calls') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'twake_outbound_missed' AND tgrelid = to_regclass('missed_calls')) THEN
    CREATE TRIGGER twake_outbound_missed AFTER INSERT ON missed_calls FOR EACH ROW WHEN (NEW.external = 'out') EXECUTE FUNCTION twake_outbound_cdr();
  END IF;
END
$twake$;
COMMIT;
`

/** The columns of `outbound_settings` in the order of the projection's `settings`. */
const SETTINGS_COLUMNS = ['default_profile', 'concurrent', 'daily_calls', 'daily_minutes', 'monthly_calls', 'monthly_minutes', 'user_concurrent', 'user_daily_calls', 'user_daily_minutes', 'user_monthly_calls', 'user_monthly_minutes'] as const

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
      settings: (await rows(`SELECT ${SETTINGS_COLUMNS.join(', ')} FROM outbound_settings WHERE tenant_id = $1`))[0] ?? [],
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
        `INSERT INTO outbound_settings (tenant_id, ${SETTINGS_COLUMNS.join(', ')}) VALUES ($1, ${SETTINGS_COLUMNS.map((_, i) => `$${i + 2}`).join(', ')}) ON CONFLICT (tenant_id) DO UPDATE SET ${SETTINGS_COLUMNS.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`,
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
