-- Step 10a, third review (ADR 0020). Idempotent: it also brings up to date a database that played 013 as it stood
-- before the second review (a test or pilot database made from the branch then), whose renewals of the lease would
-- fail on a missing column.

-- The columns 013 gained at the second review.
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS backlog integer NOT NULL DEFAULT 0;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS backlog_at timestamptz;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS erase_body boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS webhook_deliveries_held_idx ON webhook_deliveries (tenant_id, subscription_id) WHERE status = 'pending' AND claim IS NOT NULL;
DO $$
BEGIN
  -- The index of each subscription's next due, on (subscription_id) alone before.
  IF (SELECT indnatts FROM pg_index WHERE indexrelid = 'webhook_deliveries_pending_idx'::regclass) = 1 THEN
    DROP INDEX webhook_deliveries_pending_idx;
    CREATE INDEX webhook_deliveries_pending_idx ON webhook_deliveries (subscription_id, next_attempt_at, id) WHERE status = 'pending';
  END IF;
  -- The tests and replays counted per tenant, without their subscription's key (kept a minute: nothing to carry).
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'webhook_sends' AND column_name = 'tenant_id') THEN
    DROP TABLE webhook_sends;
    CREATE TABLE webhook_sends (
      tenant_id       text NOT NULL,
      subscription_id text NOT NULL,
      at              timestamptz NOT NULL
    );
    CREATE INDEX webhook_sends_idx ON webhook_sends (tenant_id, at);
  END IF;
END
$$;

-- When a subscription last had deliveries taken (claimWebhookDeliveries): of the tenants holding as few, the one
-- served least recently is served first.
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- The lease of the changes of state: `heard`, how many tenants its holder hears the events of (one that hears more
-- takes it at once from one that hears fewer); its holder writes from `write_from` until `write_until` only, a margin
-- inside the lease, so that a renewal never waits for the writes under way, and a Gateway that takes the lease over
-- writes once what the previous one was writing is done.
ALTER TABLE webhook_leases DROP COLUMN IF EXISTS healthy;
ALTER TABLE webhook_leases ADD COLUMN IF NOT EXISTS heard integer NOT NULL DEFAULT 0;
ALTER TABLE webhook_leases ADD COLUMN IF NOT EXISTS write_from timestamptz NOT NULL DEFAULT now();
ALTER TABLE webhook_leases ADD COLUMN IF NOT EXISTS write_until timestamptz NOT NULL DEFAULT now();
