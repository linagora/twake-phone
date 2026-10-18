-- Step 11a (ADR 0022): a call of the history a mailbox took (the caller left a message, or could have; the person
-- called missed it): Recents says so.
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS voicemail boolean NOT NULL DEFAULT false;
