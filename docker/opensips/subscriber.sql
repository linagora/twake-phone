
CREATE TABLE IF NOT EXISTS version (
    table_name VARCHAR(32) NOT NULL,
    table_version INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT version_t_name_idx UNIQUE (table_name)
);
CREATE TABLE IF NOT EXISTS subscriber (
    id SERIAL PRIMARY KEY NOT NULL,
    username VARCHAR(64) DEFAULT '' NOT NULL,
    domain VARCHAR(64) DEFAULT '' NOT NULL,
    password VARCHAR(25) DEFAULT '' NOT NULL,
    ha1 VARCHAR(64) DEFAULT '' NOT NULL,
    ha1_sha256 VARCHAR(64) DEFAULT '' NOT NULL,
    ha1_sha512t256 VARCHAR(64) DEFAULT '' NOT NULL,
    holder TEXT,
    CONSTRAINT subscriber_account_idx UNIQUE (username, domain)
);
CREATE INDEX IF NOT EXISTS subscriber_username_idx ON subscriber (username);
INSERT INTO version (table_name, table_version) VALUES ('subscriber', 8)
  ON CONFLICT (table_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS acc (
    id SERIAL PRIMARY KEY NOT NULL,
    method VARCHAR(16) DEFAULT '' NOT NULL,
    from_tag VARCHAR(64) DEFAULT '' NOT NULL,
    to_tag VARCHAR(64) DEFAULT '' NOT NULL,
    callid VARCHAR(64) DEFAULT '' NOT NULL,
    sip_code VARCHAR(3) DEFAULT '' NOT NULL,
    sip_reason VARCHAR(32) DEFAULT '' NOT NULL,
    time TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    duration INTEGER DEFAULT 0 NOT NULL,
    ms_duration INTEGER DEFAULT 0 NOT NULL,
    setuptime INTEGER DEFAULT 0 NOT NULL,
    created TIMESTAMP WITHOUT TIME ZONE DEFAULT NULL,
    caller VARCHAR(64) DEFAULT '' NOT NULL,
    callee VARCHAR(64) DEFAULT '' NOT NULL,
    dialled VARCHAR(64) DEFAULT '' NOT NULL
);
CREATE INDEX IF NOT EXISTS acc_callid_idx ON acc (callid);
CREATE TABLE IF NOT EXISTS missed_calls (
    id SERIAL PRIMARY KEY NOT NULL,
    method VARCHAR(16) DEFAULT '' NOT NULL,
    from_tag VARCHAR(64) DEFAULT '' NOT NULL,
    to_tag VARCHAR(64) DEFAULT '' NOT NULL,
    callid VARCHAR(64) DEFAULT '' NOT NULL,
    sip_code VARCHAR(3) DEFAULT '' NOT NULL,
    sip_reason VARCHAR(32) DEFAULT '' NOT NULL,
    time TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    setuptime INTEGER DEFAULT 0 NOT NULL,
    created TIMESTAMP WITHOUT TIME ZONE DEFAULT NULL,
    caller VARCHAR(64) DEFAULT '' NOT NULL,
    callee VARCHAR(64) DEFAULT '' NOT NULL,
    dialled VARCHAR(64) DEFAULT '' NOT NULL
);
CREATE INDEX IF NOT EXISTS missed_calls_callid_idx ON missed_calls (callid);
INSERT INTO version (table_name, table_version) VALUES ('acc', 7), ('missed_calls', 5)
  ON CONFLICT (table_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS call_rules (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    holder TEXT DEFAULT '' NOT NULL,
    forward_always VARCHAR(64),
    forward_always_holder TEXT,
    forward_busy VARCHAR(64),
    forward_busy_holder TEXT,
    forward_noanswer VARCHAR(64),
    forward_noanswer_holder TEXT,
    noanswer_delay INTEGER DEFAULT 20 NOT NULL,
    dnd BOOLEAN DEFAULT false NOT NULL,
    dnd_until TIMESTAMP WITH TIME ZONE,
    dnd_message VARCHAR(140) DEFAULT '' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS call_groups (
    number VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    name VARCHAR(64) DEFAULT '' NOT NULL,
    members VARCHAR(64)[] DEFAULT '{}' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS display_names (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    display_name VARCHAR(64) DEFAULT '' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS push_targets (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    holder TEXT DEFAULT '' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    alive_until TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
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
DELETE FROM dialplan WHERE dpid IN (1, 2);
INSERT INTO dialplan (dpid, pr, match_op, match_exp, match_flags, subst_exp, repl_exp, disabled, attrs) VALUES
  (1, 10, 1, '^(1[578]|11[2459]|19[167]|116000|116117)$', 0, NULL, NULL, 0, 'emergency'),
  (1, 20, 1, '^0([1-9][0-9]{8})$', 0, '^0([1-9][0-9]{8})$', '+33\1', 0, 'e164'),
  (1, 21, 1, '^\+330?([1-9][0-9]{8})$', 0, '^\+330?([1-9][0-9]{8})$', '+33\1', 0, 'e164'),
  (1, 22, 1, '^00330?([1-9][0-9]{8})$', 0, '^00330?([1-9][0-9]{8})$', '+33\1', 0, 'e164'),
  (1, 23, 1, '^33([1-9][0-9]{8})$', 0, '^33([1-9][0-9]{8})$', '+33\1', 0, 'e164'),
  (1, 30, 1, '^\+[1-9][0-9]{6,14}$', 0, NULL, NULL, 0, 'e164'),
  (1, 31, 1, '^00([1-9][0-9]{6,14})$', 0, '^00([1-9][0-9]{6,14})$', '+\1', 0, 'e164'),
  (1, 90, 1, '^[+0]', 0, NULL, NULL, 0, 'invalid'),
  (2, 10, 1, '^\+33[1-59][0-9]{8}$', 0, NULL, NULL, 0, 'fixed'),
  (2, 11, 1, '^\+33[67][0-9]{8}$', 0, NULL, NULL, 0, 'mobile'),
  (2, 12, 1, '^\+3380[0-5][0-9]{6}$', 0, NULL, NULL, 0, 'freephone'),
  (2, 13, 1, '^\+3380[6-9][0-9]{6}$', 0, NULL, NULL, 0, 'standard-rate'),
  (2, 14, 1, '^\+338[1-9][0-9]{7}$', 0, NULL, NULL, 0, 'premium'),
  (2, 15, 1, '^\+33', 0, NULL, NULL, 0, 'invalid'),
  (2, 20, 1, '^\+(262|508|59[046]|68[179])', 0, NULL, NULL, 0, 'overseas'),
  (2, 30, 1, '^\+', 0, NULL, NULL, 0, 'international');
ALTER TABLE subscriber ADD COLUMN IF NOT EXISTS holder TEXT;
ALTER TABLE acc ADD COLUMN IF NOT EXISTS caller VARCHAR(64) DEFAULT '' NOT NULL;
ALTER TABLE acc ADD COLUMN IF NOT EXISTS callee VARCHAR(64) DEFAULT '' NOT NULL;
ALTER TABLE acc ADD COLUMN IF NOT EXISTS dialled VARCHAR(64) DEFAULT '' NOT NULL;
ALTER TABLE missed_calls ADD COLUMN IF NOT EXISTS caller VARCHAR(64) DEFAULT '' NOT NULL;
ALTER TABLE missed_calls ADD COLUMN IF NOT EXISTS callee VARCHAR(64) DEFAULT '' NOT NULL;
ALTER TABLE missed_calls ADD COLUMN IF NOT EXISTS dialled VARCHAR(64) DEFAULT '' NOT NULL;
ALTER TABLE call_rules ADD COLUMN IF NOT EXISTS tenant_id TEXT DEFAULT '' NOT NULL;
ALTER TABLE call_rules ADD COLUMN IF NOT EXISTS holder TEXT DEFAULT '' NOT NULL;
ALTER TABLE call_rules ADD COLUMN IF NOT EXISTS forward_always_holder TEXT;
ALTER TABLE call_rules ADD COLUMN IF NOT EXISTS forward_busy_holder TEXT;
ALTER TABLE call_rules ADD COLUMN IF NOT EXISTS forward_noanswer_holder TEXT;
ALTER TABLE push_targets ADD COLUMN IF NOT EXISTS alive_until TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL;
