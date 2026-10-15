-- Step 6b (ADR 0017): the rules of the calls to the public network, as administrators set them (OutboundPolicy,
-- OutboundProfile and OutboundAssignment of @twake/telephony-types, as JSON): the Gateway writes from them what
-- OpenSIPS reads (its own `outbound_settings`, `outbound_profiles`, `outbound_users` and `fraud_detection` tables,
-- which can live in this very database: hence other names here).
CREATE TABLE outbound_policies (
  tenant_id   text PRIMARY KEY,
  policy      jsonb NOT NULL DEFAULT '{}',
  profiles    jsonb NOT NULL DEFAULT '[]',
  assignments jsonb NOT NULL DEFAULT '[]',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- What the SIP server raised for the administrators: a volume threshold crossed, a cap reached, a number outside the
-- caller's rights, emergency calls in a row (TelephonyAlert, as JSON). One row while it repeats (`count`, the last at
-- `last_at`; `dedup_key`: its kind, param, scope and extension), a new one past an hour of silence. Kept 90 days from
-- the last repeat (the Gateway purges every hour).
CREATE TABLE telephony_alerts (
  id        bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  count     integer NOT NULL DEFAULT 1,
  dedup_key text NOT NULL,
  alert     jsonb NOT NULL
);
CREATE INDEX telephony_alerts_tenant_id_idx ON telephony_alerts (tenant_id, id DESC);
CREATE INDEX telephony_alerts_open_idx ON telephony_alerts (tenant_id, dedup_key, id DESC);
CREATE INDEX telephony_alerts_last_at_idx ON telephony_alerts (last_at);

-- The fallback of a range of direct numbers (FR-C8: an extension or a ring group), in place of its trunk's
-- (`fallbackTarget` of its config).
ALTER TABLE direct_numbers ADD COLUMN fallback_target text;
