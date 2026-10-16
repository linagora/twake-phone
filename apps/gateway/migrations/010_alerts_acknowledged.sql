-- Step 7: an administrator acknowledges an alert from the app (when, and who: the user id). A repeat after that opens
-- a new alert instead of counting in the acknowledged one.
ALTER TABLE telephony_alerts ADD COLUMN acknowledged_at timestamptz;
ALTER TABLE telephony_alerts ADD COLUMN acknowledged_by text;
-- The view an administrator opens first lists the alerts not acknowledged yet: its own index, without the acknowledged
-- ones (kept 90 days) to skip.
CREATE INDEX telephony_alerts_open_idx ON telephony_alerts (tenant_id, last_at DESC, id DESC) WHERE acknowledged_at IS NULL;
