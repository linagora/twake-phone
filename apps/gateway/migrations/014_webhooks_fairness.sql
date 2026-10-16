-- Step 10a, third and fourth reviews (ADR 0020). Idempotent: it also brings up to date a database that played 013 as
-- it stood at an earlier head of the branch (69fb72e and dca340c, the first ones; 316e923, the first review; 3427359,
-- the second), a test or pilot database made from the branch then: what that 013 lacked is added, what it had
-- otherwise is made again, to the schema a database made afresh has.

-- The columns 013 gained at the reviews.
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS disabled_reason text;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS secret_prev_enc text;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS secret_prev_until timestamptz;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS failures integer NOT NULL DEFAULT 0;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS failing_since timestamptz;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS paused_until timestamptz;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS backlog integer NOT NULL DEFAULT 0;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS backlog_at timestamptz;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS subject_user text;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS erase_body boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS webhook_deliveries_held_idx ON webhook_deliveries (tenant_id, subscription_id) WHERE status = 'pending' AND claim IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_deliveries_subject_idx ON webhook_deliveries (tenant_id, subject_user) WHERE subject_user IS NOT NULL;
DO $$
BEGIN
  -- The index of each subscription's next due: on (subscription_id) alone at the first review, missing before.
  IF to_regclass('webhook_deliveries_pending_idx') IS NOT NULL
     AND (SELECT indnatts FROM pg_index WHERE indexrelid = to_regclass('webhook_deliveries_pending_idx')) = 1 THEN
    DROP INDEX webhook_deliveries_pending_idx;
  END IF;
  -- The tests and replays counted per tenant, without their subscription's key (kept a minute: nothing to carry).
  IF to_regclass('webhook_sends') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'webhook_sends' AND column_name = 'tenant_id') THEN
    DROP TABLE webhook_sends;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx ON webhook_deliveries (subscription_id, next_attempt_at, id) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS webhook_sends (
  tenant_id       text NOT NULL,
  subscription_id text NOT NULL,
  at              timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_sends_idx ON webhook_sends (tenant_id, at);

-- When a subscription last had deliveries taken (claimWebhookDeliveries): of the tenants holding as few, the one
-- served least recently is served first.
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- The lease of the changes of state (missing before the first review): `heard`, how many tenants its holder hears the
-- events of (one that hears more takes it at once from one that hears fewer); its holder writes from `write_from`
-- until `write_until` only, a margin inside the lease, so that a renewal never waits for the writes under way, and a
-- Gateway that takes the lease over writes once what the previous one was writing is done.
CREATE TABLE IF NOT EXISTS webhook_leases (
  role   text PRIMARY KEY,
  holder text NOT NULL,
  until  timestamptz NOT NULL
);
ALTER TABLE webhook_leases DROP COLUMN IF EXISTS healthy;
ALTER TABLE webhook_leases ADD COLUMN IF NOT EXISTS heard integer NOT NULL DEFAULT 0;
ALTER TABLE webhook_leases ADD COLUMN IF NOT EXISTS write_from timestamptz NOT NULL DEFAULT now();
ALTER TABLE webhook_leases ADD COLUMN IF NOT EXISTS write_until timestamptz NOT NULL DEFAULT now();
