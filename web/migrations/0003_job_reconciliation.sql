-- A completed result can commit before its private-input cleanup finishes.
-- Retain that pending cleanup independently so scheduled repair does not rerun inference.
ALTER TABLE jobs ADD COLUMN input_released_at INTEGER;
-- A successful Queue.send receipt prevents repeated redrive of a legitimately
-- waiting job. A missing receipt is safe to publish again because leases dedupe.
ALTER TABLE jobs ADD COLUMN dispatched_at INTEGER;
CREATE INDEX jobs_reconcile ON jobs(status, updated_at);
CREATE INDEX jobs_input_release ON jobs(status, input_released_at);
