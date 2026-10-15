-- Step 5 (ADR 0015): the browsers that agreed to be told of calls when no window of the app is open (Web Push).
-- One row per subscription: its push service's URL for that browser (unique) and the keys a message is encrypted
-- with, for the person signed in when it was given. A browser given to someone else moves to them; one its push
-- service says is gone (404, 410) is removed.
CREATE TABLE push_subscriptions (
  endpoint   text PRIMARY KEY CHECK (length(endpoint) <= 1024),
  tenant_id  text NOT NULL,
  user_id    text NOT NULL,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (tenant_id, user_id);

-- The Gateway's VAPID keys (RFC 8292), made at its first start unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are
-- given: one pair for the deployment, the private key encrypted with SECRETS_KEY.
CREATE TABLE vapid_keys (
  id              smallint PRIMARY KEY CHECK (id = 1),
  public_key      text NOT NULL,
  private_key_enc text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
