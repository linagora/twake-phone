-- What each person chose as presence (absent, do not disturb until a date, with a message for their callers): kept
-- per user, so that a restart of the Gateway keeps it and whoever gets their extension next does not inherit it.
-- A choice whose end (`until`) has passed is over: never read back, removed when the tenant's choices are listed.
CREATE TABLE user_presence (
  tenant_id text NOT NULL,
  user_id   text NOT NULL,
  status    text NOT NULL CHECK (status IN ('available', 'busy', 'away', 'dnd', 'offline')),
  since     timestamptz NOT NULL DEFAULT now(),
  until     timestamptz,
  message   text CHECK (length(message) <= 140),
  PRIMARY KEY (tenant_id, user_id)
);
