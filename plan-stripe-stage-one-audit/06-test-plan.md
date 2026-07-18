# Test plan

The plan distinguishes hermetic local tests from tests requiring Stripe test mode, Supabase, Cloudflare, InPost/Prodigi, or supported wallet devices. Existing tests remain; this section focuses on acceptance/regression gaps.

## Test environments

| Tier | External access | Safe by default | Purpose |
| --- | --- | --- | --- |
| Local unit/Vitest | None; mocks/fakes | Yes | Domain state machine, route validation, Stripe call contracts, side-effect idempotency |
| Local pgTAP / linked test DB | Local or dedicated non-production Supabase | Yes with isolated data | Locks, transactions, constraints, RPC idempotency/concurrency |
| Stripe CLI + local/preview endpoint | Stripe test mode | Usually; some tests create/refund test objects | Signed delivery, retry/replay, real event shapes and configured API version |
| Playwright hermetic | Local mocked backend | Yes | UI state, validation ordering, fallback/accessibility |
| Playwright checkout-edge | Stripe test mode and selected external services | Destructive/opt-in | Real confirmation, redirects, webhook, queue, fulfillment |
| Production smoke | Live config; tightly controlled | No; requires explicit operator approval | Domain/method visibility, webhook/observability health, one low-risk transaction if approved |

Never run destructive checkout-edge or production payment tests implicitly. Preserve the repository's serial/opt-in guards and redact secrets/client secrets from output.

## Unit tests — local

### Stripe configuration

- missing payment-method configuration produces the selected fail-closed error before reservation/PaymentIntent creation;
- valid configured ID is passed to `paymentIntents.create`;
- configuration/resource error rolls back reservation and exposes a stable non-secret error;
- test and production values cannot be accidentally inferred from a hard-coded fallback;
- installed SDK API version expectation is asserted/documented at the contract boundary.

### Event processor

- first event creates a received record and acquires a lease;
- duplicate concurrent handlers allow one lease owner;
- expired lease is reclaimable;
- active lease returns a retryable/non-duplicating outcome;
- completed event is an idempotent no-op after verifying required effects;
- retryable failure records safe error data and can resume;
- unsupported type is acknowledged and cannot invoke domain effects;
- raw payload, signature, customer email/address, and client secret are absent from logs/ledger;
- database failure before event insert returns non-2xx so Stripe retries;
- failure after a durable effect but before event completion resumes that effect safely.

### Order state and out-of-order delivery

Use table-driven tests for at least:

| Event sequence | Expected final order | Expected ceramic state | Fulfillment |
| --- | --- | --- | --- |
| success | paid | sold | once |
| success, duplicate success | paid | sold | once |
| success, full refund | refunded | available | no new fulfillment; existing fulfillment cancellation/escalation per policy |
| full refund, success | refunded | available/not sold | never started after refund fact |
| lost dispute, success | refunded/lost terminal representation | available/not sold | never started after lost fact |
| success, failed/canceled event | paid unless Stripe authoritative state says otherwise | sold | once |
| failed, later success | paid only if Stripe authoritative state is succeeded and reservation can be sold | sold or automatically refunded | once or never |
| late success after reservation taken | failed/refunded per existing contract | owned by winning order | never for losing order |
| partial refund | paid or explicit partially-refunded representation | sold | no relist |

Tests must not fake correctness by delivering events only in chronological order.

### Effect-level idempotency

- customer confirmation claim/send repeats once;
- studio notification repeats once;
- Stripe Customer/Invoice/finalize/pay/send idempotency survives a crash at each boundary;
- server conversion event keeps deterministic `purchase-<payment_intent_id>` and is not re-emitted incorrectly;
- InPost adoption/reference prevents duplicate shipment after timeout/retry;
- Prodigi job unique key prevents duplicate active jobs and queue sends are recoverable;
- private-sale consumption repeats safely;
- refund creation idempotency and subsequent event processing converge.

### Return page

- retrieves PaymentIntent once per mount behavior contract;
- succeeded/processing/failed UI remains informational;
- it never calls fulfillment/order mutation endpoints;
- purchase analytics and cart clearing remain deduplicated;
- missing/malformed client secret is handled without sensitive output.

## Database tests — local or dedicated Supabase

### Atomic refund/release RPC

- paid ceramic order transitions to refunded and all expected sold rows become available in one transaction;
- second identical call returns idempotent success;
- concurrent calls do not double-release;
- injected constraint/failure rolls back both order and pieces;
- a piece associated with a different order is not released;
- expected line count mismatch fails safely and leaves all state unchanged;
- print-only order does not mutate `piece_state`;
- partial refund input does not relist;
- service-role can execute; `public`, `anon`, and `authenticated` cannot;
- RLS remains enabled.

### One-of-one concurrency

- two orders reserve one available ceramic concurrently: exactly one wins;
- overlapping multi-piece baskets lock deterministically and do not deadlock;
- standard and private-sale reservation cannot both win the same piece;
- expiry takeover is atomic;
- old late-success order cannot sell a piece held/sold by the winner and is refunded;
- refund release racing a new reservation has a serializable safe result and cannot release the new owner's row;
- showroom rows remain protected;
- missing IDs fail the whole reservation.

### Event ledger

- unique Stripe event ID constraint;
- status/lease indexes support the reconciler query;
- retention process never removes unfinished/retryable events;
- event row cannot be written by client roles;
- safe error-length constraints prevent dumping payloads.

## Webhook route tests — local

Preserve existing tests and add:

- exact raw bytes, whitespace, and Unicode reach signature verification unchanged;
- missing/malformed signature returns 400 without an event row;
- unsupported but valid event returns 2xx and safe ignored state;
- processor retryable error returns non-2xx;
- event already completed returns 2xx;
- concurrent duplicate HTTP deliveries execute external effects once;
- API-version mismatch fixture fails a contract assertion or is explicitly transformed;
- every subscribed event type has a fixture generated for `2026-05-27.dahlia`;
- log assertions prove no PII/secrets.

## Failed-webhook and replay tests — Stripe test mode

With Stripe CLI or Workbench test resend:

1. point a test event destination at a controlled endpoint that returns 500;
2. verify the failed delivery appears in Workbench and the configured alert fires;
3. restore the endpoint and resend the same event ID;
4. verify one completed ledger record and one set of effects;
5. resend again while/after Stripe automatic retry is pending;
6. verify no duplicate invoice/email/shipment/job;
7. exercise an expired processing lease and ensure it resumes;
8. exercise a deliberately swallowed invoice/email failure, confirm the webhook can be 2xx, and verify Sentry/reconciler/runbook recovery catches it.

Record event IDs/order IDs only; do not copy payloads into the audit or CI artifacts.

## Stripe CLI contract tests — Stripe test mode

- generate/forward each subscribed event;
- confirm endpoint signature secret separation from Dashboard endpoint secrets;
- verify event payload fields used by the code at endpoint API version `2026-05-27.dahlia`;
- deliver duplicates and reverse logical order with controlled fixtures/recorded test object state;
- create failed, canceled, succeeded, fully refunded, partially refunded, and lost-dispute-equivalent test fixtures where Stripe test tooling supports them;
- verify manual resend command from the runbook;
- after any Stripe SDK bump, rerun payload contract tests before updating endpoint version.

The CLI's synthetic events may create prerequisite objects that differ from application-created PaymentIntents. For end-to-end order association, use test PaymentIntents created by `/api/checkout` and then act on those objects.

## Playwright — hermetic local

### Existing flow regression

- required contact/delivery fields block `/api/checkout`;
- locker checkout requires a selected locker;
- print checkout requires/validates supported destination address;
- mixed cart stays blocked;
- only after valid delivery does the PaymentIntent/Elements area appear;
- standard Payment Element remains usable if no wallet is eligible.

### Express Checkout, if retained

- feature flag off: no Express element, unchanged checkout;
- flag on and eligible mock: Express renders above Payment Element after server checkout creation;
- clicking Express cannot bypass contact/delivery/locker validation;
- wallet shipping/contact events cannot overwrite authoritative application delivery fields;
- Express error/cancel returns control without losing the attempt ID/reservation context;
- one confirm path is disabled while another is submitting;
- accessible labels, focus, error announcement, and separator;
- no duplicate wallet affordance in the fallback mock contract;
- analytics distinguishes surface without changing purchase event ID.

### Link

- Link prompt availability is controlled by Stripe Element/config mock, not a custom duplicate UI;
- Link hidden/ineligible leaves standard methods intact;
- prefilled payment identity does not falsely mark custom delivery fields valid;
- localized Link-adjacent copy does not promise delivery autofill.

## Wallet/device matrix — Stripe test mode and real supported devices

Stripe eligibility cannot be proven only with jsdom or a desktop browser spoof. Test:

| Method | Minimum environments | Assertions |
| --- | --- | --- |
| Apple Pay | Supported Safari/device with wallet; registered test domain | Visible only when eligible; confirms same PI; return/webhook/order/fulfillment correct |
| Google Pay | Supported Chrome/Android or documented supported environment; eligible account/domain | Same as above; absence is graceful where unavailable |
| Link | Fresh and returning Link user paths; supported browser | Payment confirmation works; custom store delivery remains authoritative |
| No wallet | At least one ineligible browser/device | Payment Element fallback is complete |

Cover PLN, EUR, and GBP where the configured method supports them; all locales; ceramic locker, ceramic courier/pickup, and print address. Record actual eligibility rather than treating hidden buttons as a UI defect.

## Payment Link tests if reconsidered later

Payment Links are rejected/deferred in Stage 1, so no implementation tests are required now. Before any future approval, require:

- `checkout.session.completed` and async success/failure ingestion;
- `client_reference_id`/metadata tamper and missing-reference handling;
- internal order creation idempotency by Session/PaymentIntent;
- shared atomic capacity/inventory reservation before fulfillment;
- a demonstrated concurrent storefront-versus-link purchase test for any limited resource;
- session purchase-limit behavior test proving its limits and non-reservation semantics;
- delivery/custom-field validation and InPost/print fulfillment mapping;
- customer history, analytics attribution, invoice/email deduplication, refunds, expiration, and replay;
- manual Dashboard-created link cannot sell an unregistered product/order type.

Unique ceramics must not pass review merely because these tests exist; the link must actually share the same inventory lock.

## End-to-end checkout-edge — Stripe test mode/external services

Run serially with explicit destructive opt-in:

- ceramic card success → paid/sold, one confirmation, one invoice, one InPost shipment/adoption;
- ceramic asynchronous/redirect method success where configured → same state, return page not authoritative;
- failed/canceled PI → pending reservation released according to policy;
- reservation-expiry/late success race → losing order refunded, no fulfillment;
- full refund → atomic refunded/available and print cancellation/escalation contract;
- print success → one durable fulfillment job and Prodigi progression using debug gate;
- duplicate webhook during fulfillment timeout → one external order/shipment;
- customer closes tab before return → webhook still completes order;
- return page loaded before webhook → processing UI, no client fulfillment, eventual database correctness.

Use sandbox InPost/Prodigi where available. A real external call timeout should be simulated at a dependency seam before deliberately producing sandbox duplicates.

## Production smoke tests

Require an approved window and operator:

- verify live webhook destination enabled, correct event set, and API version;
- verify live domain registrations without printing config IDs;
- inspect method visibility on supported real devices; no purchase required for basic eligibility;
- verify standard card fallback;
- confirm Workbench delivery and Sentry/Workers correlation on a harmless known event where possible;
- if a live transaction is approved, use a controlled sellable/non-unique or immediately reversible item, then verify internal order, email/invoice ownership, fulfillment suppression/handling, refund, and reconciliation;
- never use a unique customer-facing ceramic as an uncoordinated smoke-test item;
- observe error rates, checkout conflicts, webhook latency/retries, fulfillment jobs, and support reports through the rollout window.

## Test gates

Before production robustness rollout:

- full `npm test`, lint, typecheck, build (webpack), pgTAP, and CI-safe Playwright pass;
- all ordering/concurrency/failure-injection cases pass;
- test-mode replay drill completed;
- no migration drift;
- operator signs off on runbook.

Before Express rollout:

- robustness gates already deployed;
- live domains/config verified;
- real-device matrix passed;
- feature flag and kill switch tested;
- success metric and observation window approved.
