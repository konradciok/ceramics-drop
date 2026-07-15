-- pgTAP tests for the fulfilment idempotency constraints: the column UNIQUE
-- on `fulfilment_jobs.idempotency_key`, the partial unique index that allows
-- only one active job per `order_id`, and the partial unique dedup index on
-- `webhook_events(provider, provider_event_id)`. Run locally with:
--   supabase test db        (wraps each file; pgTAP must be enabled)
-- Every assertion runs inside the BEGIN/ROLLBACK below, so no fixture data
-- persists. Synthetic `tap_*` ids keep the fixtures clear of real stock.
-- Mirrors private-sale.sql / print_fulfilment_assets.sql structure.

begin;
-- pgTAP lives in `extensions` on Supabase; tables/RPCs in `public`. Missing
-- schemas in search_path are ignored, so this is safe across hosted and local.
set local search_path to extensions, public, pg_temp;

select plan(9);

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- Three orders give the idempotency-key test two distinct order_ids (so the
-- only colliding constraint is idempotency_key, not the per-order index) and
-- the per-order test a single order_id to stack active/terminal jobs on.
insert into orders (id, payment_intent_id, subtotal, shipping, total, shipping_method, status) values
  ('c0000000-0000-0000-0000-000000000001', 'tap_pi_c1', 0, 0, 0, 'odbior', 'pending'),
  ('c0000000-0000-0000-0000-000000000002', 'tap_pi_c2', 0, 0, 0, 'odbior', 'pending'),
  ('c0000000-0000-0000-0000-000000000003', 'tap_pi_c3', 0, 0, 0, 'odbior', 'pending');

-- ── Tests ───────────────────────────────────────────────────────────────────

-- 1. idempotency_key UNIQUE (fulfilment_jobs.idempotency_key, column-level):
-- a second job reusing the same key is rejected with SQLSTATE 23505. The two
-- rows use different order_ids so this isolates the idempotency_key constraint
-- from the per-order partial index below.
select lives_ok(
  $$ insert into fulfilment_jobs (order_id, idempotency_key)
     values ('c0000000-0000-0000-0000-000000000001', 'tap_idem_1') $$,
  'idempotency_key: first job inserts cleanly'
);

select throws_ok(
  $$ insert into fulfilment_jobs (order_id, idempotency_key)
     values ('c0000000-0000-0000-0000-000000000002', 'tap_idem_1') $$,
  '23505',
  null, -- skip matching the (locale-dependent) message text; errcode is enough
  'idempotency_key: a duplicate key is rejected (23505)'
);

-- 2. webhook_events dedup (partial unique index webhook_events_dedup on
-- (provider, provider_event_id) where provider_event_id is not null): a second
-- row for the same (provider, provider_event_id) is rejected with 23505.
select lives_ok(
  $$ insert into webhook_events (provider, provider_event_id, event_type)
     values ('prodigi', 'tap_evt_1', 'order.created') $$,
  'webhook_events: first event inserts cleanly'
);

select throws_ok(
  $$ insert into webhook_events (provider, provider_event_id, event_type)
     values ('prodigi', 'tap_evt_1', 'order.shipped') $$,
  '23505',
  null,
  'webhook_events: a duplicate (provider, provider_event_id) is rejected (23505)'
);

-- 2b. The dedup index is partial: a NULL provider_event_id is excluded, so a
-- second NULL-event row for the same provider is ALLOWED (proves the
-- `where provider_event_id is not null` predicate on the index).
select lives_ok(
  $$ insert into webhook_events (provider, provider_event_id, event_type)
     values ('prodigi', null, 'order.created') $$,
  'webhook_events: a NULL provider_event_id is exempt from dedup'
);

-- 3. One active job per order (partial unique index fulfilment_jobs_order_unique
-- on (order_id) where status not in ('cancelled', 'failed_action_required')):
-- a second active job for the same order is rejected with 23505. Each row gets
-- a distinct idempotency_key so the per-order index is the only thing colliding.
select lives_ok(
  $$ insert into fulfilment_jobs (order_id, idempotency_key, status)
     values ('c0000000-0000-0000-0000-000000000003', 'tap_order_1', 'queued') $$,
  'order_unique: first active job for the order inserts cleanly'
);

select throws_ok(
  $$ insert into fulfilment_jobs (order_id, idempotency_key, status)
     values ('c0000000-0000-0000-0000-000000000003', 'tap_order_2', 'queued') $$,
  '23505',
  null,
  'order_unique: a second active job for the same order is rejected (23505)'
);

-- 3b. Terminal statuses are excluded from the partial index, so a job with a
-- cancelled / failed_action_required status for the same order is ALLOWED even
-- while an active job holds it. Both values from the `status not in (...)` set
-- are exercised so a future change to either is caught.
select lives_ok(
  $$ insert into fulfilment_jobs (order_id, idempotency_key, status)
     values ('c0000000-0000-0000-0000-000000000003', 'tap_order_3', 'cancelled') $$,
  'order_unique: a cancelled job for the same order is allowed'
);

select lives_ok(
  $$ insert into fulfilment_jobs (order_id, idempotency_key, status)
     values ('c0000000-0000-0000-0000-000000000003', 'tap_order_4', 'failed_action_required') $$,
  'order_unique: a failed_action_required job for the same order is allowed'
);

select * from finish();
rollback;
