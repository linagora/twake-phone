-- Step 11b (ADR 0023): the transcriptions of the messages of the mailboxes, and the bot's notice of each in Chat. By
-- tenant, holder (the id the mailboxes know the person by, HolderRecord of step 11a, its NUL written %00) and message. Written by the Gateway
-- that holds the lease of the mailboxes (`voicemail:<tenant>`), under its generation: a write checks it in the same
-- statement. The text goes with the message: deleted, past the retention period, or erased (the person's right).
CREATE TABLE IF NOT EXISTS voicemail_transcripts (
  tenant_id text NOT NULL,
  holder text NOT NULL,
  message_id text NOT NULL,
  -- Where the mailbox was reached when the message was left: its recording is read through it.
  extension text NOT NULL,
  received_at timestamptz NOT NULL,
  -- pending | done | none | erased
  status text NOT NULL,
  -- too-long | busy | failed
  reason text,
  text text,
  attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- pending | sent | none | redact
  notice text NOT NULL,
  -- The tries of the notice (or of its withdrawal), apart from the transcription's: each queue its own.
  notice_attempts integer NOT NULL DEFAULT 0,
  notice_next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  notice_room text,
  notice_event text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, holder, message_id)
);
-- What is due (dueTranscripts), what changed (transcriptsChangedSince), the retention period.
CREATE INDEX IF NOT EXISTS voicemail_transcripts_due ON voicemail_transcripts (tenant_id, created_at) WHERE status = 'pending' OR notice IN ('pending', 'redact');
CREATE INDEX IF NOT EXISTS voicemail_transcripts_changed ON voicemail_transcripts (tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS voicemail_transcripts_received ON voicemail_transcripts (tenant_id, received_at);
