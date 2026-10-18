-- Second and third reviews of step 10b (ADR 0021). Each statement can be played again, on any database: one made
-- afresh, one that played 016 as it is, and one that played the 016 of an earlier head of the branch, which held
-- most of this (third review, n°7: 016 is never rewritten again, what follows it goes here).
--
-- Second review, n°3: the direct numbers a person had when they erased their history (E.164). A record of a call to
-- or from one of them from before is erased whoever holds the number when it is read. The row goes with the person
-- (deleteMapping), and after a few days in any case (third review, n°3).
ALTER TABLE history_erasures ADD COLUMN IF NOT EXISTS numbers text[] NOT NULL DEFAULT '{}';

-- Second review, n°2: when the erased entries were, by way, without any number. A record of the operator read later
-- that no other entry takes and that falls then is erased too (an outbound call presented with a trunk's number, that
-- no direct number tells). Third review: kept only for an organisation with an operator, for the entries a record
-- read later may be of, with a keyed print of the number on the other side (`remote_key`, HMAC with a key the Gateway
-- derives from SECRETS_KEY, never the number: n°5), and purged after a few days whatever the operator (n°3).
CREATE TABLE IF NOT EXISTS history_erased_calls (
  tenant_id   text NOT NULL,
  direction   text NOT NULL,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NOT NULL
);
ALTER TABLE history_erased_calls ADD COLUMN IF NOT EXISTS remote_key text;
CREATE INDEX IF NOT EXISTS history_erased_calls_at ON history_erased_calls (tenant_id, started_at);
CREATE INDEX IF NOT EXISTS history_erased_calls_purge ON history_erased_calls (started_at);

-- Second review, n°3: when an extension or a range of direct numbers changed hands (a mapping deleted or given
-- another extension, a range changed or deleted, or one taken again after). A record of a call from before is entered
-- in nobody's history: the call was not of whom the number rings now. Purged after a few days (third review, n°3).
CREATE TABLE IF NOT EXISTS number_changes (
  tenant_id     text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('extension', 'did')),
  first_number  text NOT NULL,
  last_number   text NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS number_changes_of ON number_changes (tenant_id, kind, first_number);
CREATE INDEX IF NOT EXISTS number_changes_purge ON number_changes (changed_at);
CREATE INDEX IF NOT EXISTS history_erasures_purge ON history_erasures (erased_at);

-- Second review, n°5: `erased`, a record whose call was erased with someone's history, apart from the others.
ALTER TABLE operator_cdrs DROP CONSTRAINT IF EXISTS operator_cdrs_outcome_check;
ALTER TABLE operator_cdrs ADD CONSTRAINT operator_cdrs_outcome_check CHECK (outcome IN ('matched', 'orphan', 'unmatched', 'forwarded', 'invalid', 'erased'));

-- Second review, n°4: an entry known from the operator alone that the operator forwarded to the fallback (its record,
-- then the forward): missed here, answered there.
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS operator_forwarded boolean NOT NULL DEFAULT false;

-- Second review, n°12: the number on the other side in E.164 as e164Of writes it (apps/gateway/src/e164.ts), the
-- characters taken out named one by one: the ASCII spaces, the no-break spaces (U+00A0, U+202F, as UTF-8 bytes: the
-- same in a UTF8 or an SQL_ASCII database) and .()-, whatever the locale of the database.
CREATE OR REPLACE FUNCTION e164_of(n text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN v ~ '^\+[1-9][0-9]{6,14}$' THEN v
    WHEN v ~ '^00[1-9][0-9]{6,14}$' THEN '+' || substr(v, 3)
    WHEN v ~ '^0[1-9][0-9]{8}$' THEN '+33' || substr(v, 2)
    ELSE v
  END
  FROM (SELECT regexp_replace(replace(replace(n, convert_from('\xc2a0', 'UTF8'), ''), convert_from('\xe280af', 'UTF8'), ''), '[\t\n\v\f\r .()-]', '', 'g') AS v) AS s
$$;
-- The entries 016 wrote under the earlier rules, written again (their remote_e164 computed afresh): only those it
-- changes, none on a database that played this already.
UPDATE call_history SET remote_number = remote_number WHERE remote_e164 IS DISTINCT FROM e164_of(remote_number);
