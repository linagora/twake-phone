-- Step 7: an administrator acknowledges an alert from the app (when, and who: the user id). A repeat after that opens
-- a new alert instead of counting in the acknowledged one.
ALTER TABLE telephony_alerts ADD COLUMN acknowledged_at timestamptz;
ALTER TABLE telephony_alerts ADD COLUMN acknowledged_by text;
