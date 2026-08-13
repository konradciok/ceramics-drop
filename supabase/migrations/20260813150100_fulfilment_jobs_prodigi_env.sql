-- L-19: persist the Prodigi environment a fulfilment job was enqueued under.
-- The env previously lived ONLY inside idempotency_key while uniqueness is
-- per-order (fulfilment_jobs_order_unique), so a sandbox→live flip made every
-- re-enqueue of an existing order collide with an unclassifiable unique
-- violation → webhook 5xx loop. With the column persisted, enqueueProdigi can
-- classify the conflict precisely and park the stale-env job as
-- failed_action_required (env_flip_conflict) instead of looping.
--
-- Additive + backward-compatible; backfill parses existing keys with the same
-- strict format the code fallback uses (full match, no prefix-only guessing).
alter table fulfilment_jobs
  add column if not exists prodigi_env text;

update fulfilment_jobs
   set prodigi_env = substring(idempotency_key from '^prodigi:(sandbox|live):')
 where prodigi_env is null
   and idempotency_key ~ '^prodigi:(sandbox|live):order:[^:]+:v1$';
