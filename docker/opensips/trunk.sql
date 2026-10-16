-- Generated from packages/provider-opensips/src/trunks.ts (TRUNK_SQL): do not edit, a unit test compares them.
CREATE TABLE IF NOT EXISTS version (
    table_name VARCHAR(32) NOT NULL,
    table_version INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT version_t_name_idx UNIQUE (table_name)
);
CREATE TABLE IF NOT EXISTS dispatcher (
    id SERIAL PRIMARY KEY NOT NULL,
    setid INTEGER DEFAULT 0 NOT NULL,
    destination VARCHAR(192) DEFAULT '' NOT NULL,
    socket VARCHAR(128) DEFAULT NULL,
    state INTEGER DEFAULT 0 NOT NULL,
    probe_mode INTEGER DEFAULT 0 NOT NULL,
    weight VARCHAR(64) DEFAULT 1 NOT NULL,
    priority INTEGER DEFAULT 0 NOT NULL,
    attrs VARCHAR(128) DEFAULT NULL,
    description VARCHAR(64) DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS dialplan (
    id SERIAL PRIMARY KEY NOT NULL,
    dpid INTEGER NOT NULL,
    pr INTEGER DEFAULT 0 NOT NULL,
    match_op INTEGER NOT NULL,
    match_exp VARCHAR(64) NOT NULL,
    match_flags INTEGER DEFAULT 0 NOT NULL,
    subst_exp VARCHAR(64) DEFAULT NULL,
    repl_exp VARCHAR(32) DEFAULT NULL,
    timerec VARCHAR(255) DEFAULT NULL,
    disabled INTEGER DEFAULT 0 NOT NULL,
    attrs VARCHAR(255) DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS registrant (
    id SERIAL PRIMARY KEY NOT NULL,
    registrar VARCHAR(255) DEFAULT '' NOT NULL,
    proxy VARCHAR(255) DEFAULT NULL,
    aor VARCHAR(255) DEFAULT '' NOT NULL,
    third_party_registrant VARCHAR(255) DEFAULT NULL,
    username VARCHAR(64) DEFAULT NULL,
    password VARCHAR(64) DEFAULT NULL,
    binding_URI VARCHAR(255) DEFAULT '' NOT NULL,
    binding_params VARCHAR(64) DEFAULT NULL,
    expiry INTEGER DEFAULT NULL,
    forced_socket VARCHAR(64) DEFAULT NULL,
    cluster_shtag VARCHAR(64) DEFAULT NULL,
    state INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT registrant_registrant_idx UNIQUE (aor, binding_URI, registrar)
);
INSERT INTO version (table_name, table_version) VALUES ('dispatcher', 9), ('dialplan', 5), ('registrant', 3)
  ON CONFLICT (table_name) DO NOTHING;
CREATE TABLE IF NOT EXISTS trunks (
    id VARCHAR(32) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    setid INTEGER NOT NULL UNIQUE,
    position INTEGER DEFAULT 0 NOT NULL,
    domain VARCHAR(128) NOT NULL,
    number_format VARCHAR(16) DEFAULT 'e164' NOT NULL,
    assert_identity SMALLINT DEFAULT 0 NOT NULL,
    auth_username VARCHAR(64) DEFAULT '' NOT NULL,
    auth_password VARCHAR(64) DEFAULT '' NOT NULL,
    auth_realm VARCHAR(128) DEFAULT '' NOT NULL,
    codec_flags VARCHAR(255) DEFAULT '' NOT NULL,
    default_number VARCHAR(16) NOT NULL,
    reg_aor VARCHAR(255) DEFAULT '' NOT NULL
);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS allowed VARCHAR(128) DEFAULT ',fixed,mobile,freephone,standard-rate,' NOT NULL;
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS countries VARCHAR(1024) DEFAULT '' NOT NULL;
CREATE TABLE IF NOT EXISTS dids (
    id VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    trunk_id VARCHAR(32) NOT NULL,
    first_number VARCHAR(16) NOT NULL,
    last_number VARCHAR(16) NOT NULL,
    target VARCHAR(64) DEFAULT '' NOT NULL,
    suffix_digits SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS dids_first_number_idx ON dids (first_number);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS fallback VARCHAR(16) DEFAULT '' NOT NULL;
ALTER TABLE dids ADD COLUMN IF NOT EXISTS fallback VARCHAR(16) DEFAULT '' NOT NULL;

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
CREATE TABLE IF NOT EXISTS outbound_usage_missed (
    id BIGSERIAL PRIMARY KEY NOT NULL,
    call_key VARCHAR(32) NOT NULL,
    subject VARCHAR(64) NOT NULL,
    ended TIMESTAMPTZ NOT NULL,
    seconds BIGINT DEFAULT 0 NOT NULL,
    answered BOOLEAN NOT NULL
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
INSERT INTO version (table_name, table_version) VALUES ('fraud_detection', 1), ('dr_gateways', 6), ('dr_rules', 4), ('dr_carriers', 3), ('dr_groups', 2), ('dialog', 12)
  ON CONFLICT (table_name) DO NOTHING;
INSERT INTO fraud_detection (ruleid, profileid, prefix, cpm_warning, cpm_critical, total_calls_warning, total_calls_critical, concurrent_calls_warning, concurrent_calls_critical, sequential_calls_warning, sequential_calls_critical, call_duration_warning, call_duration_critical) VALUES
  (1, 1, '33', 6, 20, 150, 500, 3, 0, 10, 40, 7200, 14400),
  (2, 1, '', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (3, 1, '33262', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (4, 1, '33263', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (5, 1, '33269', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (6, 1, '33590', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (7, 1, '33594', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (8, 1, '33596', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (9, 1, '33639', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (10, 1, '33690', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (11, 1, '33691', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (12, 1, '33692', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (13, 1, '33693', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (14, 1, '33694', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (15, 1, '33695', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (16, 1, '33696', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (17, 1, '33697', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600),
  (18, 1, '33976', 3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600)
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
  uc INTEGER[] := ARRAY[2, 0, 300, 0, 0];
  tc INTEGER[] := ARRAY[20, 0, 3000, 0, 0];
  pc INTEGER[];
  today DATE := (now() AT TIME ZONE 'Europe/Paris')::date;
  month DATE := date_trunc('month', now() AT TIME ZONE 'Europe/Paris')::date;
  u_dc BIGINT; u_ds BIGINT; u_mc BIGINT; u_ms BIGINT;
  t_dc BIGINT; t_ds BIGINT; t_mc BIGINT; t_ms BIGINT;
  r_user BIGINT; r_tenant BIGINT;
  n_user BIGINT; n_tenant BIGINT;
  allot BIGINT := p_max;
  share BIGINT;
  why TEXT := '';
  why_scope TEXT := '';
  dur INTEGER;
  i INTEGER;
  caps INTEGER[];
  used BIGINT[];
  reserved BIGINT[];
  ncalls BIGINT[];
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
  -- One call at a time from here (n°3): what was used, what the others hold, read as they are, then this one's share
  -- reserved. A CDR being counted waits for it (at most TRIGGER_LOCK_TIMEOUT: then it is counted as missed).
  PERFORM pg_advisory_xact_lock(60170017);
  SELECT coalesce(sum(u.calls) FILTER (WHERE u.scope = 'user' AND u.period = 'd'), 0), coalesce(sum(u.seconds) FILTER (WHERE u.scope = 'user' AND u.period = 'd'), 0),
         coalesce(sum(u.calls) FILTER (WHERE u.scope = 'user' AND u.period = 'm'), 0), coalesce(sum(u.seconds) FILTER (WHERE u.scope = 'user' AND u.period = 'm'), 0),
         coalesce(sum(u.calls) FILTER (WHERE u.scope = 'tenant' AND u.period = 'd'), 0), coalesce(sum(u.seconds) FILTER (WHERE u.scope = 'tenant' AND u.period = 'd'), 0),
         coalesce(sum(u.calls) FILTER (WHERE u.scope = 'tenant' AND u.period = 'm'), 0), coalesce(sum(u.seconds) FILTER (WHERE u.scope = 'tenant' AND u.period = 'm'), 0)
    INTO u_dc, u_ds, u_mc, u_ms, t_dc, t_ds, t_mc, t_ms
    FROM (SELECT x.scope, x.subject, x.period, x.start, x.calls, x.seconds FROM outbound_usage x
          WHERE (x.scope = 'user' AND x.subject = p_ext) OR (x.scope = 'tenant' AND x.subject = '')
          UNION ALL
          -- What a CDR could not count yet (a lock held when it was written).
          SELECT a.scope, a.subject, a.period, a.start, a.calls, a.seconds FROM outbound_usage_missed mi CROSS JOIN LATERAL twake_outbound_add(mi.subject, mi.ended, mi.seconds) a WHERE mi.answered) u
    WHERE ((u.scope = 'user' AND u.subject = p_ext) OR (u.scope = 'tenant' AND u.subject = '')) AND ((u.period = 'd' AND u.start = today) OR (u.period = 'm' AND u.start = month));
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
  -- The critical duration of the thresholds of this number (the longest prefix, as fraud_detection matches it): what
  -- the call may last, hence the most it reserves (n°5).
  SELECT f.call_duration_critical INTO dur FROM fraud_detection f WHERE f.profileid = 1 AND p_number LIKE f.prefix || '%' ORDER BY length(f.prefix) DESC LIMIT 1;
  IF dur > 0 AND dur < allot THEN
    allot := dur;
  END IF;
  IF uc[3] > 0 OR uc[5] > 0 OR tc[3] > 0 OR tc[5] > 0 THEN
    -- The calls in progress that hold minutes (their reservations, the ended ones not counted yet excepted).
    SELECT coalesce(sum(r.seconds) FILTER (WHERE r.subject = p_ext), 0), count(*) FILTER (WHERE r.subject = p_ext), coalesce(sum(r.seconds), 0), count(*)
      INTO r_user, n_user, r_tenant, n_tenant
      FROM outbound_reservations r WHERE r.until > now() AND r.call_key <> p_key AND NOT EXISTS (SELECT 1 FROM outbound_usage_missed mi WHERE mi.call_key = r.call_key);
    caps := ARRAY[uc[3], uc[5], tc[3], tc[5]];
    used := ARRAY[u_ds, u_ms, t_ds, t_ms];
    reserved := ARRAY[r_user, r_user, r_tenant, r_tenant];
    ncalls := ARRAY[n_user, n_user, n_tenant, n_tenant];
    FOR i IN 1..4 LOOP
      IF caps[i] > 0 THEN
        -- What is left, divided by the calls in progress plus this one: alone, it gets all of it.
        share := floor(greatest(caps[i]::bigint * 60 - used[i] - reserved[i], 0)::numeric / (ncalls[i] + 1));
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
  RETURN QUERY SELECT 'ok'::text, why, why_scope, allot::integer;
END
$twake$;
-- The seconds of a call answered p_secs before p_end: per day and month of Europe/Paris they were spent in (a call
-- across midnight counts in both days), the call itself on the day it was answered (the day that takes what rounding
-- left, so that the seconds add up).
CREATE OR REPLACE FUNCTION twake_outbound_add(p_who TEXT, p_end TIMESTAMPTZ, p_secs BIGINT)
RETURNS TABLE (scope TEXT, subject TEXT, period TEXT, start DATE, calls INTEGER, seconds BIGINT)
LANGUAGE sql STABLE AS $twake$
  WITH b AS (
    SELECT (p_end - make_interval(secs => greatest(p_secs, 0))) AT TIME ZONE 'Europe/Paris' AS a, p_end AT TIME ZONE 'Europe/Paris' AS e, greatest(p_secs, 0) AS total
  ), days AS (
    SELECT g::date AS d, round(extract(epoch FROM least(b.e, g + interval '1 day') - greatest(b.a, g)))::bigint AS s, g::date = b.a::date AS first, b.total
      FROM b CROSS JOIN generate_series(date_trunc('day', b.a), date_trunc('day', b.e), interval '1 day') AS g
  ), per AS (
    SELECT days.d, CASE WHEN days.first THEN days.total - (sum(days.s) OVER () - days.s) ELSE days.s END AS s, days.first::int AS c FROM days
  ), who AS (
    SELECT * FROM (VALUES ('user', p_who), ('tenant', '')) AS w(scope, subject)
  )
  SELECT who.scope, who.subject, 'd', per.d, per.c, per.s FROM per CROSS JOIN who
  UNION ALL
  SELECT who.scope, who.subject, 'm', date_trunc('month', per.d)::date, sum(per.c)::int, sum(per.s)::bigint FROM per CROSS JOIN who GROUP BY who.scope, who.subject, date_trunc('month', per.d)
$twake$;
-- What CDRs could not count when they were written (a lock held then), counted now: their reservations released,
-- their seconds added. Never waits more than TRIGGER_LOCK_TIMEOUT; what it cannot do waits for the next time. How
-- many it counted.
CREATE OR REPLACE FUNCTION twake_outbound_reconcile() RETURNS INTEGER
LANGUAGE plpgsql SET lock_timeout = '200ms' AS $twake$
DECLARE
  mi outbound_usage_missed%ROWTYPE;
  done INTEGER := 0;
BEGIN
  FOR mi IN SELECT * FROM outbound_usage_missed x ORDER BY x.id LIMIT 1000 FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      DELETE FROM outbound_reservations r WHERE r.call_key = mi.call_key;
      IF mi.answered THEN
        INSERT INTO outbound_usage AS u (scope, subject, period, start, calls, seconds)
          SELECT a.scope, a.subject, a.period, a.start, a.calls, a.seconds FROM twake_outbound_add(mi.subject, mi.ended, mi.seconds) a
          ON CONFLICT (scope, subject, period, start) DO UPDATE SET calls = u.calls + EXCLUDED.calls, seconds = u.seconds + EXCLUDED.seconds;
      END IF;
      DELETE FROM outbound_usage_missed x WHERE x.id = mi.id;
      done := done + 1;
    EXCEPTION WHEN lock_not_available OR query_canceled OR others THEN
      RAISE WARNING 'twake_outbound_reconcile: % (counted later)', SQLERRM;
      RETURN done;
    END;
  END LOOP;
  RETURN done;
END
$twake$;
CREATE OR REPLACE FUNCTION twake_outbound_cdr() RETURNS trigger
LANGUAGE plpgsql SET lock_timeout = '200ms' AS $twake$
#variable_conflict use_column
DECLARE
  answered BOOLEAN := TG_TABLE_NAME = 'acc';
  d DATE;
  m DATE;
  secs BIGINT := 0;
  who TEXT := coalesce(NEW.caller, '');
BEGIN
  IF answered THEN
    secs := greatest(coalesce(NEW.duration, 0), 0);
  END IF;
  -- Never a CDR lost nor held for this: a lock waited for TRIGGER_LOCK_TIMEOUT at most (the function's own setting:
  -- a statement_timeout set here would not apply), whatever fails is only logged, and counted later.
  BEGIN
    DELETE FROM outbound_reservations r WHERE r.call_key = md5(NEW.callid);
    IF answered THEN
      -- The day the call was answered, in Europe/Paris: the CDR is written at its end.
      d := ((now() - make_interval(secs => secs)) AT TIME ZONE 'Europe/Paris')::date;
      m := date_trunc('month', d)::date;
      -- One count at a time with twake_outbound(), which reads what is counted and what is reserved (n°3).
      PERFORM pg_advisory_xact_lock(60170017);
      -- The first CDR of a day: what is two months old goes, with the reservations past.
      IF NOT EXISTS (SELECT 1 FROM outbound_usage u WHERE u.scope = 'tenant' AND u.subject = '' AND u.period = 'd' AND u.start = d) THEN
        DELETE FROM outbound_usage u WHERE u.start < (m - interval '1 month');
        DELETE FROM outbound_reservations r WHERE r.until < now();
      END IF;
      INSERT INTO outbound_usage AS u (scope, subject, period, start, calls, seconds)
        SELECT a.scope, a.subject, a.period, a.start, a.calls, a.seconds FROM twake_outbound_add(who, now(), secs) a
        ON CONFLICT (scope, subject, period, start) DO UPDATE SET calls = u.calls + EXCLUDED.calls, seconds = u.seconds + EXCLUDED.seconds;
    END IF;
  EXCEPTION WHEN lock_not_available OR query_canceled OR others THEN
    RAISE WARNING 'twake_outbound_cdr: % (counted later)', SQLERRM;
    BEGIN
      INSERT INTO outbound_usage_missed (call_key, subject, ended, seconds, answered) VALUES (md5(NEW.callid), who, now(), secs, answered);
    EXCEPTION WHEN lock_not_available OR query_canceled OR others THEN
      RAISE WARNING 'twake_outbound_cdr: % (not counted)', SQLERRM;
    END;
    RETURN NULL;
  END;
  -- What an earlier CDR could not count: counted now.
  BEGIN
    IF EXISTS (SELECT 1 FROM outbound_usage_missed LIMIT 1) THEN
      PERFORM twake_outbound_reconcile();
    END IF;
  EXCEPTION WHEN lock_not_available OR query_canceled OR others THEN
    RAISE WARNING 'twake_outbound_cdr: % (counted later)', SQLERRM;
  END;
  RETURN NULL;
END
$twake$;
-- Before OpenSIPS starts again (docker/opensips/entrypoint.sh: no call yet). The calls it restores are the rows of
-- dialog (answered calls only: one ringing at the crash is lost): the reservations of any other call are released
-- (n°4); the emergency calls restored (dialog profile trunk_emergency), never asked whether their phone is still
-- there, end within p_emergency_sec at most (n°10); what CDRs could not count is counted.
CREATE OR REPLACE FUNCTION twake_outbound_restart(p_emergency_sec INTEGER) RETURNS TEXT
LANGUAGE plpgsql SET lock_timeout = '5s' AS $twake$
DECLARE
  counted INTEGER;
  released INTEGER;
  bounded INTEGER;
BEGIN
  counted := twake_outbound_reconcile();
  DELETE FROM outbound_reservations r WHERE NOT EXISTS (SELECT 1 FROM dialog dl WHERE md5(dl.callid) = r.call_key);
  GET DIAGNOSTICS released = ROW_COUNT;
  UPDATE dialog dl SET timeout = least(dl.timeout, extract(epoch FROM now())::integer + p_emergency_sec) WHERE dl.profiles LIKE '%trunk_emergency%';
  GET DIAGNOSTICS bounded = ROW_COUNT;
  RETURN format('%s reservation(s) of calls lost released, %s emergency call(s) bounded to %s s, %s CDR(s) counted', released, bounded, p_emergency_sec, counted);
END
$twake$;
RESET check_function_bodies;
DELETE FROM dialplan WHERE dpid IN (1, 2, 3, 4);
INSERT INTO dialplan (dpid, pr, match_op, match_exp, match_flags, subst_exp, repl_exp, disabled, attrs) VALUES
  (1, 10, 1, '^(1[578]|11[2459]|19[167]|116000|116117)$', 0, '^(.*)$', '\1', 0, 'emergency'),
  (1, 11, 1, '^116[0-9]{3}$', 0, '^(.*)$', '\1', 0, 'freephone'),
  (1, 12, 1, '^118[0-9]{3}$', 0, '^(.*)$', '\1', 0, 'premium'),
  (1, 20, 1, '^0([1-9][0-9]{8})$', 0, '^0([1-9][0-9]{8})$', '+33\1', 0, 'e164'),
  (1, 21, 1, '^\+330?([1-9][0-9]{8})$', 0, '^\+330?([1-9][0-9]{8})$', '+33\1', 0, 'e164'),
  (1, 22, 1, '^00330?([1-9][0-9]{8})$', 0, '^00330?([1-9][0-9]{8})$', '+33\1', 0, 'e164'),
  (1, 23, 1, '^33([1-9][0-9]{8})$', 0, '^33([1-9][0-9]{8})$', '+33\1', 0, 'e164'),
  (1, 30, 1, '^\+[1-9][0-9]{6,14}$', 0, '^(.*)$', '\1', 0, 'e164'),
  (1, 31, 1, '^00([1-9][0-9]{6,14})$', 0, '^00([1-9][0-9]{6,14})$', '+\1', 0, 'e164'),
  (1, 90, 1, '^[+0]', 0, '^(.*)$', '\1', 0, 'invalid'),
  (2, 9, 1, '^\+33(26[239]|59[046]|639|69[0-7]|976)[0-9]{6}$', 0, '^(.*)$', '\1', 0, 'overseas'),
  (2, 10, 1, '^\+33[1-59][0-9]{8}$', 0, '^(.*)$', '\1', 0, 'fixed'),
  (2, 11, 1, '^\+33[67][0-9]{8}$', 0, '^(.*)$', '\1', 0, 'mobile'),
  (2, 12, 1, '^\+3380[0-5][0-9]{6}$', 0, '^(.*)$', '\1', 0, 'freephone'),
  (2, 13, 1, '^\+3380[6-9][0-9]{6}$', 0, '^(.*)$', '\1', 0, 'standard-rate'),
  (2, 14, 1, '^\+338[1-9][0-9]{7}$', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 15, 1, '^\+33', 0, '^(.*)$', '\1', 0, 'invalid'),
  (2, 20, 1, '^\+(262|508|59[046]|68[179])', 0, '^(.*)$', '\1', 0, 'overseas'),
  (2, 21, 1, '^\+1(900|700|5(00|2[1-9]|33|44|66|77|88))', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+1[2-9][0-9]{2}976', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+44(9|70|8[47])', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+49(900|13[78]|180|118|700|12)', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+32(90|70|77)', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+41(90|84|878)', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+34(80[3-7]|90[1-7]|118)', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+39(89|84|178|12)', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+31(90|84|87)', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+43(9|8[12]|118)', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+351(6|70[78]|80[89])', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+352(90|801)', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 21, 1, '^\+48(70)', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 25, 1, '^\+(80[08]|87[08]|88[1238]|979|991)', 0, '^(.*)$', '\1', 0, 'premium'),
  (2, 30, 1, '^\+', 0, '^(.*)$', '\1', 0, 'international'),
  (3, 10, 1, '^([1-9][0-9]{8})$', 0, '^([1-9][0-9]{8})$', '+33\1', 0, 'e164'),
  (4, 10, 1, '^\+1(24[26]|26[48]|284|345|441|473|649|658|664|721)', 0, '^(.*)$', '\1', 0, 'international'),
  (4, 10, 1, '^\+1(758|767|784|8[024]9|86[89]|876)', 0, '^(.*)$', '\1', 0, 'international');
BEGIN;
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
