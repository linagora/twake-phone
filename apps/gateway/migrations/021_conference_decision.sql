-- A conference made of a call with the operator (step 8c, ADR 0025) waits for the person: `origin_call` is the Call-ID of
-- the call it is made of (kept until they confirm, or give up), `decision` what they chose, set once and read by every
-- Gateway: 'confirmed' or 'cancelled'. Both are NULL for any other room.
ALTER TABLE conferences ADD COLUMN IF NOT EXISTS origin_call text;
ALTER TABLE conferences ADD COLUMN IF NOT EXISTS decision text CHECK (decision IN ('confirmed', 'cancelled'));
