-- 2026-09-02 incident (order 63445e00): a real Stripe payment's fulfilment
-- job was submitted to Prodigi sandbox because PRODIGI_ENV was misconfigured.
-- The livemode-vs-PRODIGI_ENV guard in enqueueProdigi needs Stripe's
-- event.livemode to classify a mismatch. Persisting it here lets the
-- `orders -- prodigi-env-check` CLI audit read ground truth directly from
-- the DB for every row enqueued after this column exists, instead of
-- retrieving each order's PaymentIntent from Stripe — which cannot work
-- for a mixed sandbox/live audit run, since a single Stripe API key can only
-- retrieve PaymentIntents created in its own mode (test keys can't read live
-- objects and vice versa; see docs/orders-cli.md).
--
-- Legacy rows (enqueued before this column existed) stay NULL — the CLI
-- falls back to a best-effort Stripe lookup for those and reports them as
-- unverifiable rather than a hard failure when that lookup can't succeed.
--
-- Additive + backward-compatible, same shape as 20260813150100_fulfilment_jobs_prodigi_env.sql.
alter table fulfilment_jobs
  add column if not exists livemode boolean;
