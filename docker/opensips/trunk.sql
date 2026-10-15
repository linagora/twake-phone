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
INSERT INTO version (table_name, table_version) VALUES ('fraud_detection', 1), ('dr_gateways', 6), ('dr_rules', 4), ('dr_carriers', 3), ('dr_groups', 2)
  ON CONFLICT (table_name) DO NOTHING;
INSERT INTO fraud_detection (ruleid, profileid, prefix, cpm_warning, cpm_critical, total_calls_warning, total_calls_critical, concurrent_calls_warning, concurrent_calls_critical, sequential_calls_warning, sequential_calls_critical, call_duration_warning, call_duration_critical) VALUES
  (1, 1, '33', 6, 20, 150, 500, 3, 0, 10, 40, 14400, 0),
  (2, 1, '', 3, 6, 20, 60, 2, 4, 5, 15, 3600, 0)
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
  coalesce((SELECT left_ FROM uc), 1000000000), coalesce((SELECT param FROM uc), ''),
  coalesce((SELECT left_ FROM tc), 1000000000), coalesce((SELECT param FROM tc), ''),
  coalesce((SELECT left_ FROM sc), 1000000000), coalesce((SELECT param FROM sc), ''), coalesce((SELECT scope FROM sc), '')
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
DO $twake$
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
