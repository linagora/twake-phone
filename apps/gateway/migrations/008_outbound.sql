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

-- What the SIP server raised for the administrators: a volume threshold crossed, a cap reached (TelephonyAlert, as
-- JSON). Kept 90 days.
CREATE TABLE telephony_alerts (
  id        bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  alert     jsonb NOT NULL
);
CREATE INDEX telephony_alerts_tenant_at_idx ON telephony_alerts (tenant_id, at DESC);

-- The fallback number of a range of direct numbers (FR-C8), in place of its trunk's (`fallbackNumber` of its config).
ALTER TABLE direct_numbers ADD COLUMN fallback_number text;
