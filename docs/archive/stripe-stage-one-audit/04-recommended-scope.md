# Recommended scope

This is the smallest coherent high-ROI scope. It does not authorize implementation and does not include production code.

## Must implement

### 1. Convergent Stripe event processing

**Behavior**

- A paid, refunded, canceled, or lost-dispute Stripe object must converge the internal order to the correct terminal state regardless of webhook delivery order or duplication.
- A refund or lost dispute observed before `payment_intent.succeeded` must prevent later fulfillment. The handler should retrieve authoritative Stripe state when event ordering makes the local transition ambiguous, or persist a terminal payment fact that the later success handler must honor.
- Event processing must have durable states such as received, processing with an expiring lease, completed, retryable failure, and ignored/unsupported. Do not mark an event completed before its required durable domain effects are committed.
- Duplicates may re-enter safely and resume incomplete effects. The design should not promise transport-level exactly-once delivery.
- Store only non-sensitive correlation/error summaries; do not copy full Stripe payloads containing customer data unless a retention/security decision explicitly requires it.

**Likely affected code**

- `src/app/api/stripe/webhook/route.ts`
- `src/lib/webhook.ts`
- `src/lib/orders.ts`
- a new focused Stripe event-processing repository/module under `src/lib/`
- operational scripts/tests that replay or reconcile an event/order

**Affected schema**

Prefer a dedicated `stripe_webhook_events` table rather than overloading the Prodigi-oriented `webhook_events` contract, unless a deliberate provider-neutral redesign is made. Candidate fields: `event_id` unique, `event_type`, Stripe object/payment identifier, processing status, attempt count, lease expiry, last error code/summary, received/completed timestamps, and endpoint API version. Avoid raw payload by default.

Add a durable terminal-payment fact or a state-transition function that can reconcile pending orders against refund/dispute facts. Exact shape must be designed with the current `orders` enum and admin refund flow; do not add parallel ambiguous status columns without a transition table.

**Migration requirements**

- First bring the two remote-only Supabase migrations into reviewed repository history.
- Add one forward-only migration with RLS enabled and service-role-only access.
- Add unique/index constraints for event ID and lease/status queries.
- Provide a safe backfill rule: existing orders are not assigned synthetic completed events; reconciliation is based on current order/Stripe state.

**External configuration**

- Keep webhook destination version aligned with the SDK version.
- Ensure subscribed event set includes every event the reconciler relies on. If the chosen design uses additional events, update test and live destinations together.

**Backward compatibility**

- Existing PaymentIntent IDs, order rows, private-sale behavior, return URLs, and fulfillment jobs must remain valid.
- Old duplicate events must be safe even if no historical ledger row exists.
- Manual Stripe resend must not duplicate email, invoice, shipment, conversion, or Prodigi submission.

**Acceptance criteria**

- Refund-before-success, lost-dispute-before-success, success-before-refund, duplicate success, and concurrent duplicate deliveries all converge to correct order/inventory/fulfillment state.
- A refunded/lost order cannot later enqueue shipment or Prodigi work.
- A crash/throw between durable phases resumes rather than skips or duplicates effects.
- Operators can identify the order/event and whether processing is complete without viewing PII.

### 2. Atomic or retry-resumable refund and inventory release

**Behavior**

- Changing an order from paid to refunded and changing its ceramic rows from sold to available must either commit in one Supabase transaction/RPC or leave an explicit intermediate state that retries can finish.
- The operation remains idempotent for full refunds and lost disputes. Partial refunds continue not to relist unless product policy changes separately.
- Print orders must follow their existing cancellation/manual-escalation contract and must not call ceramic release logic.

**Likely affected code**

- `src/lib/webhook.ts` (`releaseSale`)
- `src/lib/orders.ts` or a focused inventory transition wrapper
- admin refund path if it duplicates status transition assumptions

**Affected schema**

- Preferred: a security-definer RPC that locks the order and its `piece_state` rows, validates current states, performs the transition, and returns a typed/idempotent result.
- Alternative: explicit `refund_release_pending` state plus a reconciler. This is more operationally complex and should be chosen only if external print effects require it.

**Migration requirements**

- RPC/function, execute grants restricted to `service_role`, tests for row locks and repeat calls.

**External configuration**

None.

**Backward compatibility**

- Existing refunded rows with pieces still sold need a one-time dry-run report and explicit reviewed repair command, not an automatic broad relist.

**Acceptance criteria**

- Injected failure cannot leave an order permanently refunded while its intended ceramic release is silently skipped on retry.
- Concurrent calls return the same effective result without relisting a ceramic sold to another valid order.

### 3. Stripe operations and recovery runbook

**Behavior**

- Name an operator/on-call recipient and define alerts for non-2xx webhook deliveries, sustained endpoint degradation, elevated Stripe API errors, and queue/DLQ or Sentry fulfillment errors.
- Document how to correlate Stripe event → PaymentIntent/charge → internal order → fulfillment job/shipment without exposing customer details in shared logs.
- Provide decision trees for automatic retry, Dashboard resend, Stripe CLI resend, order reconciler, email resend, invoice recovery, InPost inspection, Prodigi job inspection, and escalation.
- State explicitly that replaying an event is safe only after idempotency/convergence tests pass.

**Likely affected files**

- a new operations document under `docs/` (exact location to be chosen)
- `docs/orders-cli.md` and relevant Prodigi/checkout docs for cross-links
- optionally structured correlation logs in the webhook/event processor
- optionally extend `scripts/reconcile-orders.mjs` only where a demonstrated recovery action is missing

**Affected schema**

The event-processing table above supplies durable recovery status. No additional monitoring table should be created merely to reproduce Workbench.

**External configuration**

- Stripe Workbench event destination and health alerts in both test/live modes;
- Sentry alert ownership/routing;
- Cloudflare Queue DLQ notification/inspection procedure;
- verify webhook secret rotation procedure.

**Migration requirements**

None beyond event processing.

**Backward compatibility**

Operational only; alert thresholds should be staged to avoid noise.

**Acceptance criteria**

- A named operator can recover a simulated failed invoice/email and a retryable shipment failure using only the runbook.
- A non-2xx test webhook produces the intended alert.
- The runbook states when not to resend and how to verify absence of duplicate side effects.

### 4. Portable payment-method configuration and domain readiness

**Behavior**

- Replace the hard-coded payment-method configuration ID with a required or deliberately optional runtime variable validated before creating a PaymentIntent.
- Decide and document whether absence means fail closed or use account dynamic methods. Because BLIK/P24/Bizum availability is a business requirement and configurations are account-specific, explicit fail-closed production configuration is safer.
- Maintain distinct test/live configuration values. Log only a non-sensitive suffix/correlation or a generic “configuration unavailable” error.
- Register every checkout domain/subdomain in the corresponding Stripe mode and verify method eligibility.

**Likely affected files**

- `src/app/api/checkout/route.ts`
- `.env.example`
- Cloudflare deployment documentation
- checkout route tests
- possibly incorporate the already-authored approach from commit `e8e8f91` after reviewing it against current HEAD

**Affected schema / migration**

None.

**External configuration**

- Workers runtime secret/variable for the payment-method configuration ID;
- Stripe test and live payment-method configurations;
- Stripe payment-method domain registrations;
- Apple Pay/Google Pay/Link method enablement and account eligibility.

**Backward compatibility**

- Roll out the environment variable before deploying code that requires it.
- Preserve the standard card Payment Element fallback.

**Acceptance criteria**

- Test mode creates a PaymentIntent with a configuration that exists in test mode.
- Production configuration is checked without revealing its full ID.
- Apple Pay/Google Pay/Link eligibility is tested on supported devices/browsers; ineligible environments retain Payment Element card/payment-method checkout.

## Should implement

### 5. Make swallowed post-payment failures visible and reconcilable

**Behavior**

- Preserve the good property that an invoice/email-only problem does not re-run shipment blindly.
- Convert silent 200-only failures into durable actionable state plus Sentry/operator notification.
- Ensure customer/studio email claims and invoice state can be retried independently and safely.

**Likely affected code**

- `src/lib/webhook.ts`
- `src/lib/orders.ts`
- `src/lib/invoice.ts`
- `scripts/reconcile-orders.mjs`

**Schema**

Prefer using/clarifying existing claim and `invoiced_at` fields. Add a small attempt/error state only if the event/effect processor cannot represent it. Do not store email bodies or PII errors.

**External configuration**

Sentry alert routing and Stripe/Resend operational ownership.

**Acceptance criteria**

- Forced invoice and email failures are visible and recoverable without duplicating successful fulfillment.

## Optional

### 6. Feature-flagged Express Checkout experiment

**Prerequisites**

- configuration/domain readiness complete;
- live baseline for checkout start → PaymentIntent creation → payment success by device/browser/method;
- confirmed product decision that wallets should be more prominent;
- robustness must-implement items deployed first.

**Behavior**

- Render Express Checkout Element above Payment Element only after `/api/checkout` returns `client_secret` and inside the same `Elements` provider.
- Use the existing PaymentIntent, return URL, reservation, order, and webhook pipeline.
- Do not allow wallet-provided shipping data to override the validated application delivery method/address/locker.
- Keep Payment Element visible/fallback. Avoid duplicate wallet buttons according to Stripe's combined-Element behavior.
- Feature flag by environment and support rapid disable.

**Likely affected files**

- `src/components/shop/CheckoutForm.tsx` or a focused child component
- checkout CSS and localized explanatory copy
- analytics event definitions
- unit/Playwright/destructive edge specs

**Schema / migration**

No payment schema change. Analytics may need a non-PII payment-surface dimension; keep it out of order correctness.

**External configuration**

Domains and method configuration; supported test devices/accounts.

**Backward compatibility / rollback**

Disable the flag to return immediately to Payment Element only. Existing PaymentIntents remain confirmable.

**Acceptance criteria**

- Required delivery/locker validation cannot be bypassed.
- Ceramic and print orders still produce identical internal rows and fulfillment effects.
- No double-rendered wallets; standard Payment Element remains usable.
- Experiment has a predeclared success metric and no increase in checkout/order conflicts or fulfillment errors.

## Deferred

### Payment Links for workshops, deposits, custom work, and B2B

Before reconsideration, define:

- internal order kind and line-item model;
- whether payments are full, deposits, installments, or manually captured;
- inventory/capacity reservation and expiration;
- delivery/attendance/customer-field contract;
- tax/invoice/fiscal owner;
- cancellations/refunds;
- `checkout.session.*` ingestion and delayed methods;
- customer history, analytics, and reconciliation.

Only then compare a Payment Link/Checkout Session adapter with a small internal admin-created order/payment flow. A dashboard link that does not create a compatible internal order is not acceptable.

### Address Element / deeper Link autofill

Potentially useful for print postal addresses, but it is a checkout-form and localization change, not needed to retain Link payment. Evaluate separately against InPost, custom validation, and saved-address/privacy requirements.

## Rejected

- Payment Links for unique ceramics, private-sale ceramics, or current prints.
- Checkout Sessions migration in Stage 1.
- A custom monitoring interface duplicating Workbench.
- Enabling generic automatic receipts without a customer-communication/accounting decision.
- Moving fulfillment authority to the return/success page.
- Treating metadata, a Payment Link purchase limit, or a Stripe product quantity as a substitute for the Supabase one-of-one lock.
- Tax automation or Canary Islands tax work in this stage.
