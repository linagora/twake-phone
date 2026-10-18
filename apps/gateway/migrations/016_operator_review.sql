-- Review of step 10b (ADR 0021).
--
-- n°1: when each person last erased their history. A record of the operator of a call from before is never entered
-- in their history again, whenever it is read.
CREATE TABLE IF NOT EXISTS history_erasures (
  tenant_id  text NOT NULL,
  user_id    text NOT NULL,
  erased_at  timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

-- n°8: what the platform knows of its operator, the same for every Gateway and kept across a restart. That is the
-- state of each line, the last read of the records, a round asked, and the quota of the rounds asked.
CREATE TABLE IF NOT EXISTS operator_state (
  tenant_id   text NOT NULL,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- n°19 and n°20: a record that cannot be read as a call (a date without its offset, an unknown way). It is kept so
-- that it is never read again, and it is settled `invalid`.
ALTER TABLE operator_cdrs ADD COLUMN IF NOT EXISTS invalid text;
ALTER TABLE operator_cdrs DROP CONSTRAINT IF EXISTS operator_cdrs_outcome_check;
ALTER TABLE operator_cdrs ADD CONSTRAINT operator_cdrs_outcome_check CHECK (outcome IN ('matched', 'orphan', 'unmatched', 'forwarded', 'invalid'));
-- The records of a number (an erasure: the direct numbers of the person).
CREATE INDEX IF NOT EXISTS operator_cdrs_called ON operator_cdrs (tenant_id, called) WHERE called IS NOT NULL;
CREATE INDEX IF NOT EXISTS operator_cdrs_calling ON operator_cdrs (tenant_id, calling) WHERE calling IS NOT NULL;

-- n°3: a record is matched with the entries of its own number and time only, never with the whole tenant's
-- history over a window. The number on the other side is kept in E.164, as e164Of writes it (apps/gateway/src/e164.ts):
-- the same rules, one changed with the other.
CREATE OR REPLACE FUNCTION e164_of(n text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN v ~ '^\+[1-9][0-9]{6,14}$' THEN v
    WHEN v ~ '^00[1-9][0-9]{6,14}$' THEN '+' || substr(v, 3)
    WHEN v ~ '^0[1-9][0-9]{8}$' THEN '+33' || substr(v, 2)
    ELSE v
  END
  FROM (SELECT regexp_replace(n, '[[:space:].()-]', '', 'g') AS v) AS s
$$;
-- Computed by PostgreSQL itself: every entry, old or new, written by any version of the Gateway. On a large history,
-- this rewrites the table under an exclusive lock (the pilot kit says so).
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS remote_e164 text GENERATED ALWAYS AS (e164_of(remote_number)) STORED;
CREATE INDEX IF NOT EXISTS call_history_near ON call_history (tenant_id, direction, remote_e164, started_at) WHERE operator_cdr IS NULL AND NOT operator_only;
DROP INDEX IF EXISTS call_history_unreconciled;
