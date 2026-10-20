-- Recording and supervision of the calls that have a channel at Wazo (step 11d, ADR 0029). A recording is the record of
-- a file that Wazo's Asterisk wrote (the audio is on the recordings server, never here): who held the extension, which
-- call, who started it, how long, and what became of the audio. `purged` keeps the row (not the voice) for the journal.
-- One recording under way per call. The journal of the supervision keeps who did what, never a number or a word said.
CREATE TABLE IF NOT EXISTS recordings (
  id           uuid PRIMARY KEY,
  tenant_id    text NOT NULL,
  extension    text NOT NULL,
  user_id      text,
  display_name text,
  call_id      text NOT NULL,
  started_by   text NOT NULL,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  state        text NOT NULL CHECK (state IN ('recording', 'ready', 'failed', 'erasing', 'purged')),
  size_bytes   bigint
);
CREATE INDEX IF NOT EXISTS recordings_by_tenant ON recordings (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS recordings_by_user ON recordings (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recordings_one_per_call ON recordings (tenant_id, call_id) WHERE state = 'recording';
CREATE TABLE IF NOT EXISTS supervision_log (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL,
  at           timestamptz NOT NULL,
  actor        text NOT NULL,
  action       text NOT NULL,
  extension    text,
  recording_id uuid
);
CREATE INDEX IF NOT EXISTS supervision_log_by_tenant ON supervision_log (tenant_id, at DESC, id DESC);
