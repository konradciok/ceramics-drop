-- pgTAP tests for the partial unique dedup index on
-- `webhook_events(provider, provider_event_id)` — the idempotency ledger every
-- Stripe webhook delivery is claimed through. Run locally
-- with:
--   supabase test db        (wraps each file; pgTAP must be enabled)
-- Every assertion runs inside the BEGIN/ROLLBACK below, so no fixture data
-- persists. Synthetic `tap_*` ids keep the fixtures clear of real events.

begin;
-- pgTAP lives in `extensions` on Supabase; tables/RPCs in `public`. Missing
-- schemas in search_path are ignored, so this is safe across hosted and local.
set local search_path to extensions, public, pg_temp;

select plan(4);

-- webhook_events dedup (partial unique index webhook_events_dedup on
-- (provider, provider_event_id) where provider_event_id is not null): a second
-- row for the same (provider, provider_event_id) is rejected with 23505.
select lives_ok(
  $$ insert into webhook_events (provider, provider_event_id, event_type)
     values ('stripe', 'tap_evt_1', 'payment_intent.succeeded') $$,
  'webhook_events: first event inserts cleanly'
);

select throws_ok(
  $$ insert into webhook_events (provider, provider_event_id, event_type)
     values ('stripe', 'tap_evt_1', 'charge.refunded') $$,
  '23505',
  null, -- skip matching the (locale-dependent) message text; errcode is enough
  'webhook_events: a duplicate (provider, provider_event_id) is rejected (23505)'
);

-- NULL provider_event_id rows never collide: two of them for the same
-- provider both insert.
select lives_ok(
  $$ insert into webhook_events (provider, provider_event_id, event_type)
     values ('stripe', null, 'payment_intent.succeeded') $$,
  'webhook_events: a first NULL provider_event_id row inserts'
);

select lives_ok(
  $$ insert into webhook_events (provider, provider_event_id, event_type)
     values ('stripe', null, 'payment_intent.succeeded') $$,
  'webhook_events: a second NULL provider_event_id row for the same provider also inserts'
);

select * from finish();
rollback;
