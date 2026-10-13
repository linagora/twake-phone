-- Telephony Gateway schema. Every table is keyed by tenant: no query may run without one.

CREATE TABLE provider_configs (
  id         bigserial PRIMARY KEY,
  tenant_id  text NOT NULL,
  site       text NOT NULL DEFAULT 'default',
  type       text NOT NULL,
  -- Secrets are never stored here, only references ("env:ARI_PASSWORD", later a vault path).
  config     jsonb NOT NULL,
  UNIQUE (tenant_id, site)
);

CREATE TABLE user_mappings (
  tenant_id    text NOT NULL,
  user_id      text NOT NULL,
  extension    text NOT NULL,
  display_name text,
  PRIMARY KEY (tenant_id, user_id),
  UNIQUE (tenant_id, extension)
);

CREATE TABLE call_history (
  tenant_id     text NOT NULL,
  user_id       text NOT NULL,
  call_id       text NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  remote_number text NOT NULL,
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  duration_sec  integer NOT NULL DEFAULT 0,
  state         text NOT NULL,
  answered      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, user_id, call_id)
);
CREATE INDEX call_history_by_user ON call_history (tenant_id, user_id, started_at DESC);

CREATE TABLE sip_credentials (
  tenant_id  text NOT NULL,
  user_id    text NOT NULL,
  -- Encrypted by the Gateway (AES-256-GCM); the database never sees a clear secret.
  secret_enc text NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
