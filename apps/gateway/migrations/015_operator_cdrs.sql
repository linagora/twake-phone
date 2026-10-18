-- Step 10b (ADR 0021): the operator's records of calls (CDR, OVHcloud's `voiceConsumption`), each read once, and
-- what became of it (reconciled with a call of the history, entered alone in someone's history, or neither). The
-- numbers go once the person whose call it was erased their history; the record stays, read, never read again.
CREATE TABLE IF NOT EXISTS operator_cdrs (
  tenant_id     text NOT NULL,
  operator      text NOT NULL,
  id            text NOT NULL,
  line          text NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  forwarded     boolean NOT NULL DEFAULT false,
  calling       text,
  called        text,
  started_at    timestamptz NOT NULL,
  duration_sec  integer NOT NULL CHECK (duration_sec >= 0),
  read_at       timestamptz NOT NULL DEFAULT now(),
  outcome       text CHECK (outcome IN ('matched', 'orphan', 'unmatched', 'forwarded')),
  call_id       text,
  user_id       text,
  PRIMARY KEY (tenant_id, operator, id)
);
-- The records to reconcile, and the statistics of a period.
CREATE INDEX IF NOT EXISTS operator_cdrs_pending ON operator_cdrs (tenant_id, operator, started_at) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS operator_cdrs_started ON operator_cdrs (tenant_id, operator, started_at);
CREATE INDEX IF NOT EXISTS operator_cdrs_purge ON operator_cdrs (started_at);

-- An entry of the history reconciled with an operator's record (`operator`, `operator_cdr`), or known from it alone.
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS operator text;
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS operator_cdr text;
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS operator_only boolean NOT NULL DEFAULT false;
-- The entries of a period not reconciled yet, every person of the tenant; and the entries of a call.
CREATE INDEX IF NOT EXISTS call_history_unreconciled ON call_history (tenant_id, started_at) WHERE operator_cdr IS NULL AND NOT operator_only;
CREATE INDEX IF NOT EXISTS call_history_by_call ON call_history (tenant_id, call_id);
