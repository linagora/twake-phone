-- Step 10a (ADR 0020): the tools an administrator subscribes to the organisation's events. The secret their
-- deliveries are signed with is kept encrypted with SECRETS_KEY (AES-256-GCM, bound to the tenant and the
-- subscription), shown once, never read back by the API. The one it replaced still signs until `secret_prev_until`
-- (a day), so that the subscriber has time to take the new one.
-- `failures`: attempts failed in a row since `failing_since` (none since a delivery went through); past a few, the
-- subscription is paused until `paused_until` (its deliveries wait), and after a day of failures it is disabled
-- (`disabled_reason` 'failing') and the administrators are alerted.
CREATE TABLE webhook_subscriptions (
  id                text PRIMARY KEY,
  tenant_id         text NOT NULL,
  url               text NOT NULL,
  events            text[] NOT NULL,
  description       text,
  enabled           boolean NOT NULL DEFAULT true,
  disabled_reason   text,
  secret_enc        text NOT NULL,
  secret_prev_enc   text,
  secret_prev_until timestamptz,
  failures          integer NOT NULL DEFAULT 0,
  failing_since     timestamptz,
  paused_until      timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  created_by        text
);
CREATE INDEX webhook_subscriptions_tenant_idx ON webhook_subscriptions (tenant_id, created_at, id);

-- The domains a tenant's subscriptions may point to (a host name, or `*.domain` for its subdomains).
CREATE TABLE webhook_domains (
  tenant_id text NOT NULL,
  position  integer NOT NULL,
  domain    text NOT NULL,
  PRIMARY KEY (tenant_id, domain)
);

-- One event for one subscription, and its delivery: the queue the Gateways share (SELECT … FOR UPDATE SKIP LOCKED),
-- and the log administrators read. `body`: the exact JSON sent at each attempt. A pending delivery is due at
-- `next_attempt_at`; one a Gateway took is held until then (its lease) under `claim`. Once per subscription and event,
-- whichever Gateway queues it. `subject_user`: the person the event is about (erased with their history). Kept 30
-- days.
CREATE TABLE webhook_deliveries (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL,
  subscription_id text NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
  event_id        text NOT NULL,
  event_type      text NOT NULL,
  body            text NOT NULL,
  subject_user    text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL,
  next_attempt_at timestamptz,
  claim           text,
  last_attempt_at timestamptz,
  last_status     integer,
  last_error      text,
  delivered_at    timestamptz,
  UNIQUE (subscription_id, event_id)
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_pending_idx ON webhook_deliveries (subscription_id) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_log_idx ON webhook_deliveries (subscription_id, created_at DESC, id DESC);
CREATE INDEX webhook_deliveries_created_idx ON webhook_deliveries (created_at);
CREATE INDEX webhook_deliveries_subject_idx ON webhook_deliveries (tenant_id, subject_user) WHERE subject_user IS NOT NULL;

-- The tests and replays an administrator asked of a subscription, for their limit (a number a minute, whatever
-- Gateway or administrator asks). Kept a minute.
CREATE TABLE webhook_sends (
  subscription_id text NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
  at              timestamptz NOT NULL
);
CREATE INDEX webhook_sends_idx ON webhook_sends (subscription_id, at);

-- What the subscribers were last told of a subject (`trunk:<id>`: up, degraded or down; `presence:<user>`: a status)
-- and as of when (`since`, on the database's clock): a change is told once, never one older than what was told.
CREATE TABLE webhook_state (
  tenant_id text NOT NULL,
  subject   text NOT NULL,
  state     text NOT NULL,
  since     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, subject)
);

-- Which Gateway tells the changes of state (presences, trunks) of every tenant, until when: one at a time, so that
-- one which heard OpenSIPS later than another never tells what is already past. Taken again by another once it lapses.
CREATE TABLE webhook_leases (
  role   text PRIMARY KEY,
  holder text NOT NULL,
  until  timestamptz NOT NULL
);
