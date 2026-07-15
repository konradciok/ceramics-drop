-- Claim column for the cron-driven "failed_action_required" alert.
-- The scheduled sweep (worker.ts) queries unalerted failed_action_required jobs,
-- emails the studio + fires Sentry, then SETs alerted_at so re-runs never
-- re-alert the same row. Mirrors prodigi_orders.cancel_alerted_at.
alter table fulfilment_jobs add column if not exists alerted_at timestamptz;
