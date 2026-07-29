-- Stripe now shares the webhook_events idempotency ledger (provider='stripe'),
-- alongside Prodigi. The Stripe wrapper reuses the existing columns
-- (provider, provider_event_id, event_type, status 'processing'|'done'|'failed',
-- raw_json, processing_started_at, processed_at) and the partial unique dedup
-- index — no schema/columns change. This migration only records the second
-- provider at the schema level via COMMENT.
--
-- NOTE: deliberately NO NOT-NULL constraint on provider_event_id. A NULL
-- provider_event_id is a *supported* row that opts out of dedup — the dedup index
-- is partial (`where provider_event_id is not null`), a property pinned by
-- supabase/tests/fulfilment_idempotency.sql (test 2b). Both real writers (the
-- Prodigi callback and this Stripe wrapper) always supply the provider's event id,
-- so dedup still applies to every row they write.
COMMENT ON TABLE webhook_events IS
  'Inbound-webhook idempotency ledger; dedup is one row per (provider, provider_event_id) via a PARTIAL unique index (NULL provider_event_id opts out of dedup). Providers: prodigi (leased CAS — server/prodigi/callbacks.ts) and stripe (leased CAS — app/api/stripe/webhook/route.ts).';
