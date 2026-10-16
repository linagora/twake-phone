-- Step 6b, second review (n°8): the alerts are listed by their last repeat, the latest first (an attack that repeats
-- for days stays on top of the alerts that came once since), `id` breaking ties and paging with it; and what the first
-- of a repeated alert said is kept (`first_alert`; `alert` is the last), its first value and number among it.
ALTER TABLE telephony_alerts ADD COLUMN first_alert jsonb;
UPDATE telephony_alerts SET first_alert = alert WHERE first_alert IS NULL;
DROP INDEX telephony_alerts_tenant_id_idx;
CREATE INDEX telephony_alerts_tenant_last_idx ON telephony_alerts (tenant_id, last_at DESC, id DESC);
