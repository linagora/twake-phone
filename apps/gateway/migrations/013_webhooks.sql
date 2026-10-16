-- Step 10a (ADR 0020): the tools an administrator subscribes to the organisation's events. The secret their
-- deliveries are signed with is kept encrypted with SECRETS_KEY (AES-256-GCM), shown once, never read back by the API.
CREATE TABLE webhook_subscriptions (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  url         text NOT NULL,
  events      text[] NOT NULL,
  description text,
  enabled     boolean NOT NULL DEFAULT true,
  secret_enc  text NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  created_by  text
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
-- whichever Gateway queues it. Kept 30 days.
CREATE TABLE webhook_deliveries (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL,
  subscription_id text NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
  event_id        text NOT NULL,
  event_type      text NOT NULL,
  body            text NOT NULL,
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
CREATE INDEX webhook_deliveries_log_idx ON webhook_deliveries (subscription_id, created_at DESC, id DESC);
CREATE INDEX webhook_deliveries_created_idx ON webhook_deliveries (created_at);

-- What the subscribers were last told of a subject (`trunk:<id>`: up, degraded or down; `presence:<user>`: a status),
-- so that a change several Gateways hear (each one reads OpenSIPS) is told once, by whichever writes it first.
CREATE TABLE webhook_state (
  tenant_id text NOT NULL,
  subject   text NOT NULL,
  state     text NOT NULL,
  since     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, subject)
);
