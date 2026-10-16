-- Step 7 (review 7, n°12): the view an administrator opens first lists the alerts not acknowledged yet: its own index,
-- without the acknowledged ones (kept 90 days) to skip. Apart from 010, which databases of the branch may have applied
-- without it; IF NOT EXISTS for those that applied the 010 that had it.
CREATE INDEX IF NOT EXISTS telephony_alerts_unacknowledged_idx ON telephony_alerts (tenant_id, last_at DESC, id DESC) WHERE acknowledged_at IS NULL;
