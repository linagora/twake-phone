-- Step 6 (ADR 0016): the trunks to an operator and their direct numbers (SDA), as administrators set them. The
-- Gateway writes from them what OpenSIPS reads (its own `trunks`, `dids`, `dispatcher` and `registrant` tables, which
-- can live in this very database: hence other names here).
-- A trunk's settings are JSON (Trunk of @twake/telephony-types, without its id); its password apart, encrypted with
-- SECRETS_KEY (or an env:NAME reference). The first trunk kept serves the callers no direct number names.
CREATE TABLE trunk_configs (
  tenant_id    text NOT NULL,
  id           text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  config       jsonb NOT NULL,
  password_enc text,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

-- A range of direct numbers in E.164, from first_number to last_number (same length), and what it rings: `target`
-- (an extension or a group) for each of them, or, with suffix_digits, the extension made of the last digits of the
-- number called.
CREATE TABLE direct_numbers (
  tenant_id     text NOT NULL,
  id            text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  trunk_id      text NOT NULL,
  first_number  text NOT NULL,
  last_number   text NOT NULL,
  target        text,
  suffix_digits smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, trunk_id) REFERENCES trunk_configs (tenant_id, id) ON DELETE CASCADE
);
