-- Step 8b (ADR 0019): a call of the history that was a conference's (the room called the person in the place of a
-- call of theirs): Recents says so.
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS conference boolean NOT NULL DEFAULT false;
