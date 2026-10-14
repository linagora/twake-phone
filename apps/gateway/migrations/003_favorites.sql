-- Favourite contacts of a user. contact_id is the directory's identifier (an LDAP uid, for instance): the Gateway
-- resolves it against the directory at read time, so a contact that left the directory simply disappears.
CREATE TABLE favorites (
  tenant_id  text NOT NULL,
  user_id    text NOT NULL,
  contact_id text NOT NULL CHECK (length(contact_id) <= 256),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, contact_id)
);
