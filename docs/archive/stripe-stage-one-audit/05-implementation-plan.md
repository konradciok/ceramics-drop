# Implementation plan

This plan is advisory. No step should begin until the audit is approved. Production code was not changed by the audit.

## Phase 0 — decisions, access, and baselines

Dependencies: none.

1. Review and approve/reject each scope item in `04-recommended-scope.md`.
2. Restore authenticated Supabase MCP or equivalent direct read-only PostgreSQL introspection. Verify live functions, grants, RLS policies, triggers, constraints, and indexes rather than relying only on migration history.
3. Bring the two remote-only product-status migrations into the repository, confirm checksums/order, and return linked migration history to zero drift.
4. Obtain read-only live Stripe Dashboard access or pair with an owner. Verify without recording secret values:
   - live/test payment-method configurations;
   - live/test payment-method domains;
   - live webhook subscribed events and API version;
   - automatic receipt email settings;
   - Workbench/health-alert availability;
   - Apple Pay/Google Pay/Link eligibility.
5. Capture a conversion baseline by device/browser/payment method where consent and data availability permit: checkout started, internal checkout created, PaymentIntent failed/succeeded, and return-page success. Do not infer a wallet bottleneck without data.
6. Identify the operator and escalation route for payments, fulfillment, and customer communication.

Exit criteria: live configuration is known, database migration drift is resolved, and product/operational owners approve the state model.

## Phase 1 — configuration portability (small, reversible)

Dependencies: Phase 0 live/test PMC decisions.

Likely files:

- `src/app/api/checkout/route.ts`
- `.env.example`
- `docs/cloudflare-deployment.md`
- checkout route tests

Steps:

1. Review the approach in non-HEAD commit `e8e8f91` but reimplement/rebase deliberately against the audited revision.
2. Add a validated runtime setting for the payment-method configuration. Choose fail-closed production behavior and an explicit local/test setup.
3. Configure test/live values before the code rollout.
4. Register test/live domains/subdomains in Stripe and verify standard Payment Element methods.
5. Deploy configuration first, then code; run a test-mode smoke and one non-destructive production method-visibility check.

Rollback: revert code to the known configuration only if that configuration belongs to the target account/mode; preferably keep both old and new environment settings during the rollout. No schema rollback.

## Phase 2 — database transition and event-processing design

Dependencies: Phase 0 schema introspection/drift resolution.

Likely files:

- new migration(s) under `supabase/migrations/`
- pgTAP tests under `supabase/tests/`
- a design note documenting state transitions

Steps:

1. Enumerate the authoritative transitions for pending, paid, failed, expired, refunded, disputed/lost, and late success. Decide whether a separate payment-state fact is needed rather than overloading fulfillment/order status.
2. Define an atomic `release_sale`-style RPC:
   - lock order and expected ceramic lines/state;
   - accept repeat invocation;
   - prevent release if rows belong to another valid order;
   - transition order and pieces together;
   - return a typed outcome.
3. Define `stripe_webhook_events` (or a consciously provider-neutral successor) with unique event ID, status, lease, attempts, correlation, safe error summary, and timestamps.
4. Define processing semantics:
   - insert/upsert received;
   - acquire expiring lease;
   - run resumable domain effects;
   - complete only after required durable effects;
   - release/expire lease on retryable failure;
   - retain unsupported types as safely ignored if useful.
5. Decide how refund/dispute facts prevent a later success. Preferred designs should query/reconcile Stripe current state only when local ordering is ambiguous, limiting extra API calls.
6. Add RLS, service-role-only grants, indexes, retention policy, and non-PII logging rules.
7. Dry-run an audit for existing `orders.status='refunded'` whose ceramic rows remain sold. Review every candidate manually before any repair.

Rollout: migration first while old code ignores new table/RPC; verify functions and permissions in preview. Migration must be forward-compatible and not rewrite existing order state automatically.

Rollback: code can stop using the new structures. Avoid a destructive schema rollback; leave inert tables/functions until post-incident confidence and remove only in a later migration.

## Phase 3 — webhook convergence implementation

Dependencies: Phase 2 schema deployed.

Likely files:

- `src/app/api/stripe/webhook/route.ts`
- `src/lib/webhook.ts`
- `src/lib/orders.ts`
- new Stripe event/state repository module
- webhook, order, invoice, fulfillment, and pgTAP tests

Steps:

1. Wrap authenticated events in the durable lease/attempt contract.
2. Refactor domain effects so retries can determine already-completed state independently:
   - paid/inventory sell;
   - conversions;
   - customer/studio email;
   - invoice;
   - InPost shipment or Prodigi enqueue;
   - refund/dispute sale release.
3. Replace the split `releaseSale()` writes with the atomic RPC.
4. Add order-state reconciliation for unordered refund/dispute/success. Ensure a terminal refund/lost fact gates fulfillment before any external shipment/job call.
5. Keep unknown events as safe 2xx ignores, recorded without payload if the ledger design calls for it.
6. Add structured logs with event ID, event type, internal order ID, processing phase, and safe result. Never log signature, client secret, address, email, full payment method, or payload.
7. Preserve the existing correct raw-body verification boundary.
8. Run all tests, Stripe CLI duplicate/out-of-order scenarios, and preview verification.

Feature flag: a server-side `STRIPE_WEBHOOK_PROCESSOR_V2` can shadow-record/compare decisions before it owns effects, but **do not let both processors perform side effects**. A flag must choose one owner per event.

Rollout order:

1. deploy schema;
2. shadow/observe event receipt and correlation if designed safely;
3. enable v2 in test/preview;
4. destructive Stripe test-mode suite;
5. enable production with immediate Workbench/Sentry observation;
6. keep old code deployable for a short rollback window.

Rollback: switch event ownership back to v1 only if new events have not introduced states v1 misinterprets. If state compatibility cannot be guaranteed, roll forward with a patched v2 instead.

## Phase 4 — operations and recovery

Dependencies: Phase 3 processing semantics known; basic configuration can start earlier.

Likely files:

- new `docs/` Stripe operations runbook
- `docs/orders-cli.md`
- `scripts/reconcile-orders.mjs` only for missing safe actions
- Sentry/Cloudflare/Stripe external settings

Steps:

1. Configure Workbench event-destination and health alerts in test, exercise them, then mirror in live.
2. Configure Sentry routes for application failures that return 2xx (invoice/email) and thrown fulfillment failures.
3. Document correlation and safe inspection commands.
4. Document replay windows and methods: automatic retry, Dashboard resend, CLI resend.
5. Define recovery paths for:
   - failed webhook delivery;
   - processing lease stuck/expired;
   - invoice missing;
   - customer/studio email missing;
   - InPost retryable/nonretryable error;
   - Prodigi job retry/DLQ;
   - refunded order with inconsistent inventory;
   - late succeeded payment after reservation expiry.
6. Run a tabletop incident and record time-to-detection/time-to-recovery.

Rollback: alerts can be disabled if noisy; retain the runbook and durable event history. Do not disable correctness logic to silence alerts.

## Phase 5 — optional Express Checkout experiment

Dependencies: Phases 1, 3, and 4 complete; product baseline and explicit approval.

Likely files:

- `src/components/shop/CheckoutForm.tsx` or new focused component
- component CSS/messages
- analytics definitions
- unit and Playwright tests

Steps:

1. Add a kill-switch feature flag, initially off in production.
2. Render Express Checkout Element inside the existing post-validation `Elements` tree above Payment Element.
3. Confirm the same PaymentIntent and use the same return URL. Ignore wallet shipping as authoritative application delivery data.
4. Preserve standard Payment Element fallback and accessible separator/error state.
5. Verify supported combinations: Apple Pay on Safari/device, Google Pay on supported browser/device/account, Link logged-in/logged-out, ineligible fallback, PLN/EUR/GBP, all four locales, ceramics locker/courier/pickup, and print address.
6. Enable a small measured cohort or environment, monitor order conflicts/payment errors/fulfillment, then decide using predeclared metrics.

Success criteria:

- statistically/usefully improved payment completion or reduced time-to-confirm for eligible users;
- no increase in validation bypass, order conflict, double confirmation, fulfillment mismatch, or support contacts;
- no regression for ineligible users.

Rollback: turn off the flag. No database or PaymentIntent migration is required.

## Explicitly absent phases

There is no Stage 1 Checkout Sessions migration, Payment Link rollout, automatic-receipt enablement, tax automation, or replacement of the application's delivery form. Reconsider these only through separate business cases.

## Production verification checklist

- Package and webhook endpoint API versions match (`2026-05-27.dahlia` at audit time).
- Correct live PMC exists and is referenced; test ID is not used in live or vice versa.
- All live checkout domains are registered.
- A real low-value/operator-approved test or equivalent live-mode verification confirms card/wallet visibility without exposing or retaining payment data.
- Duplicate event resend produces no duplicate invoice/email/shipment/job/conversion.
- Out-of-order synthetic/test events converge correctly.
- Refunded ceramic order and `piece_state` change atomically.
- Return page remains informational.
- Workbench, Sentry, Workers logs, Queue/DLQ, and Supabase event state correlate by safe IDs.
- Operator completes the runbook recovery drill.
