CREATE TABLE conferences (
  meeting_id    text PRIMARY KEY,
  tenant_id     text NOT NULL,
  owner_user_id text NOT NULL,
  -- Dial-in PIN of the meeting; low sensitivity (useless without the dial-in number) and shown to the owner.
  pin           text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conferences_by_owner ON conferences (tenant_id, owner_user_id);
