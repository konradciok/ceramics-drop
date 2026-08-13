-- M-12: reconciliation clock for the cron sweep over stale prodigi_orders.
--
-- The shared re-fetch-and-merge (src/server/prodigi/merge.ts) bumps updated_at
-- on MEANINGFUL provider progress, so the sweep needs its own clock — otherwise
-- a no-op poll would either refresh the very timestamp it filters on (hiding
-- the row forever) or re-poll every tick. `last_reconciled_at` records the last
-- sweep poll; `stalled_poll_count` counts consecutive no-progress polls (the
-- prodigi_order_stalled alert fires when it reaches 2).
--
-- Additive + backward-compatible: old code ignores both columns; a NULL
-- last_reconciled_at falls back to updated_at in the sweep predicate.
alter table prodigi_orders
  add column if not exists last_reconciled_at timestamptz,
  add column if not exists stalled_poll_count smallint not null default 0;
