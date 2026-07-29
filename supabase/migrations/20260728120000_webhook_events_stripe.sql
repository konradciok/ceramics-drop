-- Stripe now shares the webhook_events idempotency ledger (provider='stripe'),
-- alongside Prodigi. The Stripe wrapper reuses the existing columns
-- (provider, provider_event_id, event_type, status 'processing'|'done',
-- raw_json, processed_at) — no new columns.
--
-- Harden the dedup contract BOTH providers depend on: a NULL provider_event_id
-- slips past the partial unique index (webhook_events_dedup, which is `where
-- provider_event_id is not null`) and would therefore never dedup. Both writers
-- always supply the provider's event id, so no legitimate row is NULL; add the
-- constraint NOT VALID so future writes are checked without a full-table
-- scan/lock on existing rows.
ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_event_id_present
  CHECK (provider_event_id IS NOT NULL) NOT VALID;

COMMENT ON TABLE webhook_events IS
  'Inbound-webhook idempotency ledger, one row per (provider, provider_event_id). Providers: prodigi (leased CAS — server/prodigi/callbacks.ts) and stripe (leased CAS — app/api/stripe/webhook/route.ts).';
