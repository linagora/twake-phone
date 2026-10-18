-- Step 11a (ADR 0022): a call of the history a mailbox took (the caller left a message, or could have; the person
-- called missed it): Recents says so.
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS voicemail boolean NOT NULL DEFAULT false;

-- The generation of each lease: one more for each lease taken (from another holder, or once it lapsed), the same
-- while it is renewed. The mailboxes' writes in the SIP server's database carry it (their fencing token): a counter,
-- not a clock, so that a clock that goes back never makes the writes of the holder look older than the last one.
ALTER TABLE webhook_leases ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
