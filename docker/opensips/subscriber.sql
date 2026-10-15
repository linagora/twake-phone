-- OpenSIPS 3.6 auth_db schema (subscriber), the copy packages/provider-opensips keeps in SUBSCRIBER_SCHEMA.
-- Loaded by PostgreSQL at first start of the Compose stack so OpenSIPS finds its table; the Gateway writes the rows.
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
    CONSTRAINT subscriber_account_idx UNIQUE (username, domain)
);
CREATE INDEX IF NOT EXISTS subscriber_username_idx ON subscriber (username);
INSERT INTO version (table_name, table_version) VALUES ('subscriber', 8)
  ON CONFLICT (table_name) DO NOTHING;

-- OpenSIPS acc schema (acc, missed_calls: the CDRs, the reference of the call history), plus the caller and callee
-- as dialled (acc extra fields), which the default columns do not carry.
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
    callee VARCHAR(64) DEFAULT '' NOT NULL
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
    callee VARCHAR(64) DEFAULT '' NOT NULL
);
CREATE INDEX IF NOT EXISTS missed_calls_callid_idx ON missed_calls (callid);
INSERT INTO version (table_name, table_version) VALUES ('acc', 7), ('missed_calls', 5)
  ON CONFLICT (table_name) DO NOTHING;

-- Our own table (step 4b, ADR 0013): forwards and "do not disturb" per extension, written by the Gateway
-- (CallRules of provider-opensips), read by opensips.cfg.tpl at each INVITE (sqlops). OpenSIPS does not check it.
-- tenant_id and the holders (who held the extension, and each target, when the rule was written) are the Gateway's:
-- it drops the rules of an extension, or a forward, whose holder changed.
CREATE TABLE IF NOT EXISTS call_rules (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    holder TEXT NOT NULL,
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
-- Tables created beforehand by OpenSIPS's own scripts lack caller and callee: added here, once, by the owner (the
-- Gateway only adds a missing one, see SubscriberProvisioner.ensureSchema), or every CDR insert would fail.
ALTER TABLE acc ADD COLUMN IF NOT EXISTS caller VARCHAR(64) DEFAULT '' NOT NULL;
ALTER TABLE acc ADD COLUMN IF NOT EXISTS callee VARCHAR(64) DEFAULT '' NOT NULL;
ALTER TABLE missed_calls ADD COLUMN IF NOT EXISTS caller VARCHAR(64) DEFAULT '' NOT NULL;
ALTER TABLE missed_calls ADD COLUMN IF NOT EXISTS callee VARCHAR(64) DEFAULT '' NOT NULL;
