# Payment-Failed State Machine Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `payment_intent.payment_failed` from terminally killing an order — it is a per-attempt Stripe event, not a terminal one, and a customer can legitimately retry with a different card on the same PaymentIntent. Today that retry succeeds at Stripe but is silently dropped by our webhook (no email, no fulfilment, no invoice, no conversion tracking) because the order was already marked `failed` and the pieces released.

**Architecture:** Split the shared `payment_intent.payment_failed` / `payment_intent.canceled` dispatch in `src/lib/webhook.ts` so only the genuinely terminal `canceled` event releases the reservation hold; `payment_failed` becomes a no-op (the 15-minute reservation TTL and the 1-hour cron sweep already reclaim an abandoned hold). As defense-in-depth, `markPaid` in `src/app/api/stripe/webhook/route.ts` now alerts via Sentry — instead of returning silently — whenever a `payment_intent.succeeded` event lands on an order already marked `failed`/`expired`, since that means money moved for an order nobody will fulfil.

**Tech Stack:** Next.js 16 App Router (Cloudflare Workers), TypeScript, Stripe SDK, Supabase, Vitest, Playwright.

## Global Constraints

- Source audit: `docs/audits/event-system-audit.md`, finding F-01 (**Critical**).
- No DB migration needed — the `order_status` Postgres enum already has all 5 values this fix uses (`pending`, `paid`, `failed`, `expired`, `refunded`).
- Test runner is Vitest: `npx vitest run <path>` (never jest).
- This is the Stripe webhook critical path. After every step that touches `src/lib/webhook.ts` or `src/app/api/stripe/webhook/route.ts`, run the **full** test file (not a `-t`-filtered subset) — both files have ~15+ other cases (refund convergence, dispute handling, under-fulfilment auto-refund, email claim-once) that must not regress.
- Scope is strictly: the `payment_failed`/`canceled` dispatch split, and the new dead-order alert in `markPaid`. Do not touch `releaseSale`, `createShipment`, the email-claim helpers, or the CAS logic inside `markPaid`'s success path.
- Commit after each task.

---

### Task 1: Stop releasing the reservation hold on `payment_intent.payment_failed`

**Files:**
- Modify: `src/lib/webhook.ts`
- Test: `src/lib/webhook.test.ts`
- Test: `src/app/api/stripe/webhook/route.test.ts`

**Interfaces:**
- Consumes: `WebhookDeps.releaseHold(paymentIntentId: string): Promise<void>` (signature unchanged — now only invoked for `payment_intent.canceled`), `WebhookDeps.revalidate(tag: string): void`.
- Produces: `handleStripeEvent(event, deps)` behavior change — `payment_intent.payment_failed` is now a no-op branch that calls neither `releaseHold` nor `revalidate`.

- [ ] **Step 1: Replace the outdated unit test and add a `canceled` test**

In `src/lib/webhook.test.ts`, replace:

```ts
  it('on failure: releases the hold', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'payment_intent.payment_failed', data: { object: pi('pi_2') } } as unknown as Stripe.Event, d);
    expect(d.releaseHold).toHaveBeenCalledWith('pi_2');
  });
```

with:

```ts
  it('on a failed attempt: does not release the hold (per-attempt event, not terminal)', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'payment_intent.payment_failed', data: { object: pi('pi_2') } } as unknown as Stripe.Event, d);
    expect(d.releaseHold).not.toHaveBeenCalled();
    expect(d.revalidate).not.toHaveBeenCalled();
  });

  it('on cancellation: releases the hold', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'payment_intent.canceled', data: { object: pi('pi_3') } } as unknown as Stripe.Event, d);
    expect(d.releaseHold).toHaveBeenCalledWith('pi_3');
    expect(d.revalidate).toHaveBeenCalledWith('inventory');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/webhook.test.ts -t "on a failed attempt"`
Expected: FAIL — today's dispatch still calls `releaseHold`/`revalidate` for `payment_intent.payment_failed` (shared case with `canceled`), so `expect(d.releaseHold).not.toHaveBeenCalled()` fails.

- [ ] **Step 3: Split the dispatch in `src/lib/webhook.ts`**

Replace the `WebhookDeps.releaseHold` doc comment:

```ts
  /** Return reserved pieces to available for a failed/canceled intent. */
  releaseHold: (paymentIntentId: string) => Promise<void>;
```

with:

```ts
  /** Return reserved pieces to available for a canceled PaymentIntent. */
  releaseHold: (paymentIntentId: string) => Promise<void>;
```

Replace the shared case block:

```ts
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent;
      await deps.releaseHold(pi.id);
      deps.revalidate('inventory');
      return;
    }
```

with:

```ts
    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent;
      await deps.releaseHold(pi.id);
      deps.revalidate('inventory');
      return;
    }
    case 'payment_intent.payment_failed':
      // Per-attempt, not terminal: Stripe fires this on every declined
      // confirmation while the PaymentIntent stays open for retry with a
      // different payment method (typical: a second card, same PI id).
      // Releasing the hold here let a same-PI retry that later succeeds land
      // on an already-`failed` order and silently do nothing (markPaid's
      // `existing.status !== 'paid'` branch) — money taken, no order. The
      // 15-minute reservation TTL (and the cron sweep after 1h) already
      // reclaims an abandoned hold, so no action is needed on this event.
      return;
```

- [ ] **Step 4: Run the unit test file to verify it passes**

Run: `npx vitest run src/lib/webhook.test.ts`
Expected: PASS — all cases, including the untouched `payment_intent.succeeded`, `charge.refunded`, `charge.dispute.closed`, and conversions-dedup tests.

- [ ] **Step 5: Run the route integration test to reveal the now-broken fixtures**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts`
Expected: FAIL — 2 cases in `describe('webhook releaseHold', ...)` now fail. Those tests build a `payment_intent.payment_failed` event via `failedEventRequest()` and assert `calls.pieceUpdated === true`; after Step 3 that event no longer triggers a `piece_state` write.

- [ ] **Step 6: Update the route-level fixtures for the new dispatch**

In `src/app/api/stripe/webhook/route.test.ts`, replace:

```ts
function failedEventRequest() {
  constructEventAsync.mockResolvedValue({
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_1' } },
  });
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{}',
  });
}

describe('webhook releaseHold', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
  });

  it('first delivery: transitions pending→failed and relists the reserved pieces', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(failedEventRequest());

    expect(res.status).toBe(200);
    expect(calls.pieceUpdated).toBe(true);
    expect(calls.pieceUpdatePayload).toEqual({ status: 'available', reserved_until: null, order_id: null });
  });

  it('retry after the order is already failed: still re-attempts the release (no stuck reserved pieces)', async () => {
    const { supabase, calls } = makeSupabase({
      // pending→failed update matches nothing on the retry (already failed)
      ordersUpdate: { data: [], error: null },
      // fallback fetch finds the already-failed order
      ordersSelect: { data: { id: 'o1', private_sale_id: null }, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(failedEventRequest());

    expect(res.status).toBe(200);
    // Without the retry-safe fallback the release would be skipped and pieces stay reserved.
    expect(calls.pieceUpdated).toBe(true);
  });
});
```

with:

```ts
function canceledEventRequest() {
  constructEventAsync.mockResolvedValue({
    type: 'payment_intent.canceled',
    data: { object: { id: 'pi_1' } },
  });
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{}',
  });
}

function failedEventRequest() {
  constructEventAsync.mockResolvedValue({
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_1' } },
  });
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{}',
  });
}

describe('webhook releaseHold', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
  });

  it('first delivery: transitions pending→failed and relists the reserved pieces', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(canceledEventRequest());

    expect(res.status).toBe(200);
    expect(calls.pieceUpdated).toBe(true);
    expect(calls.pieceUpdatePayload).toEqual({ status: 'available', reserved_until: null, order_id: null });
  });

  it('retry after the order is already failed: still re-attempts the release (no stuck reserved pieces)', async () => {
    const { supabase, calls } = makeSupabase({
      // pending→failed update matches nothing on the retry (already failed)
      ordersUpdate: { data: [], error: null },
      // fallback fetch finds the already-failed order
      ordersSelect: { data: { id: 'o1', private_sale_id: null }, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(canceledEventRequest());

    expect(res.status).toBe(200);
    // Without the retry-safe fallback the release would be skipped and pieces stay reserved.
    expect(calls.pieceUpdated).toBe(true);
  });
});

describe('webhook payment_intent.payment_failed', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
  });

  it('is a no-op: a failed attempt does not release the hold (per-attempt event, not terminal)', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: { data: [], error: null },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(failedEventRequest());

    expect(res.status).toBe(200);
    expect(calls.pieceUpdated).toBe(false);
  });
});
```

- [ ] **Step 7: Run the full route test file to verify it passes**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts`
Expected: PASS — all cases, including refund/dispute convergence, under-fulfilment, and email-claim tests untouched by this change.

- [ ] **Step 8: Commit**

```bash
git add src/lib/webhook.ts src/lib/webhook.test.ts src/app/api/stripe/webhook/route.test.ts
git commit -m "fix(webhook): payment_intent.payment_failed no longer releases the reservation hold"
```

---

### Task 2: Alert when `payment_intent.succeeded` lands on a dead order

**Files:**
- Modify: `src/app/api/stripe/webhook/route.ts` (the `markPaid` dependency implementation)
- Test: `src/app/api/stripe/webhook/route.test.ts`

**Interfaces:**
- Consumes: `Sentry.captureMessage(message: string, options?: { level?: string; extra?: Record<string, unknown> }): void` — already imported in this file as `import * as Sentry from '@sentry/nextjs';`.
- Produces: no new exports. `markPaid`'s fallback branch now alerts (console.error + Sentry.captureMessage) before returning `false` when the order status is `failed` or `expired`; `paid` (idempotent retry) and `refunded` (releaseSale's documented pending→refunded race) stay silent, matching existing behavior.

**Note on `trackPurchase`:** `handleStripeEvent` (`src/lib/webhook.ts`) calls `deps.trackPurchase(pi.id)` unconditionally on every `succeeded` event, regardless of what `markPaid` returns — this task does not change that, and does not need to. `sendPurchaseConversions` (`src/lib/marketing/conversions.ts:48`) already has its own independent guard, `if (order.status !== 'paid') return;`, checked *after* this task's `markPaid` change runs and confirms the order is still `failed`/`expired` (i.e. never flipped to `paid`) — so no server-side conversion is ever sent for the dead-order case this task alerts on. If the `2026-07-26-server-conversions-reliability.md` plan's claim-once column (`conversions_sent_at`) is implemented first or after, it claims unconditionally before this same status check, but the downstream no-op is unaffected — the claim is just spent without a send, which is harmless since a `failed`/`expired` PaymentIntent cannot later succeed (Stripe's state machine).

- [ ] **Step 1: Write the failing tests**

Add to `src/app/api/stripe/webhook/route.test.ts`, immediately after the existing `describe('webhook markPaid unknown payment_intent (F9b)', ...)` block (which ends at line 528) and before `describe('webhook markPaid under-fulfillment failed-write CAS guard (F10)', ...)`:

```ts
describe('webhook markPaid succeeded-on-dead-order alert (F-01)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(createOrderShipment).mockClear();
  });

  it('succeeded lands on an already-failed order: alerts via Sentry, does not fulfil, does not throw', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'failed', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'failed' }, error: null },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(createOrderShipment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('markPaid: succeeded on a dead order', 'pi_1', 'o1', 'failed');
    expect(Sentry.captureMessage).toHaveBeenCalledWith('stripe_webhook_succeeded_on_dead_order', {
      level: 'error',
      extra: { payment_intent_id: 'pi_1', order_id: 'o1', order_status: 'failed' },
    });
    consoleErrorSpy.mockRestore();
  });

  it('succeeded lands on an already-expired order: alerts via Sentry', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'expired', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'expired' }, error: null },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('stripe_webhook_succeeded_on_dead_order', {
      level: 'error',
      extra: { payment_intent_id: 'pi_1', order_id: 'o1', order_status: 'expired' },
    });
    consoleErrorSpy.mockRestore();
  });

  it('succeeded lands on an already-refunded order: no alert (releaseSale\'s documented race)', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'refunded', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'refunded' }, error: null },
      variantRows: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith('stripe_webhook_succeeded_on_dead_order', expect.anything());
  });
});
```

- [ ] **Step 2: Run the tests to verify the alert cases fail**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts -t "succeeded-on-dead-order"`
Expected: the `failed` and `expired` cases FAIL — today `existing.status !== 'paid'` just `return false`s with no Sentry call. The `refunded` case already PASSES (no alert exists at all today, so "not called" is trivially true).

- [ ] **Step 3: Add the alert to `markPaid`'s fallback branch**

In `src/app/api/stripe/webhook/route.ts`, replace:

```ts
        if (existing.status !== 'paid') return false;
```

with:

```ts
        if (existing.status === 'failed' || existing.status === 'expired') {
          // Stripe just confirmed payment for an order we consider dead. After the
          // payment_failed fix in webhook.ts this should be rare — reachable only
          // via a genuine payment_intent.canceled, or the under-fulfilment
          // auto-refund branch below — but money moved, so silence would hide it.
          // `paid` (below) is a normal idempotent retry; `refunded` is releaseSale's
          // documented pending→refunded race (refund observed before success) —
          // neither needs an alert.
          console.error('markPaid: succeeded on a dead order', pi, existing.id, existing.status);
          Sentry.captureMessage('stripe_webhook_succeeded_on_dead_order', {
            level: 'error',
            extra: { payment_intent_id: pi, order_id: existing.id, order_status: existing.status },
          });
        }
        if (existing.status !== 'paid') return false;
```

- [ ] **Step 4: Run the full route test file to verify it passes**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts`
Expected: PASS — all cases, including Task 1's new `payment_intent.payment_failed` describe block and every pre-existing case.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/stripe/webhook/route.ts src/app/api/stripe/webhook/route.test.ts
git commit -m "fix(webhook): alert via Sentry when a succeeded payment lands on a dead order"
```

---

### Task 3: Manually verify the fix against Stripe test mode

**This task requires a running environment with live Stripe webhook delivery** (either `stripe listen --forward-to localhost:3000/api/stripe/webhook` against local dev, or a Cloudflare preview deploy whose webhook endpoint is already registered in the Stripe Dashboard test mode) — it cannot be run by an autonomous coding agent alone, and it is the one check that validates the actual Stripe-side assumption behind this fix (that `payment_intent.payment_failed` really is non-terminal and the same PaymentIntent really can succeed after it), which no unit test with mocked Stripe events can prove. This closes the audit's own stated verification gap for F-01 ("do potwierdzenia w logach webhooka na koncie testowym").

- [ ] **Step 1: Start webhook forwarding**

Run: `stripe listen --forward-to localhost:3000/api/stripe/webhook` (or use a preview URL with its webhook already configured in the Stripe Dashboard, test mode).
Expected: the CLI prints a webhook signing secret and stays connected, forwarding events to the app.

- [ ] **Step 2: Start a checkout and decline the first card**

In a browser against the same environment: add one ceramic piece to cart, go to `/koszyk`, choose Paczkomat delivery, fill contact details, click pay. When the Stripe Payment Element mounts, pay with the decline test card `4000000000000002` (the same card `e2e/stripe-decline.spec.ts` uses).
Expected: Stripe shows a decline error; the cart is NOT cleared (same PaymentIntent stays mounted for retry).

- [ ] **Step 3: Confirm `payment_intent.payment_failed` was delivered and did not touch the order**

In the `stripe listen` terminal (or Stripe Dashboard → Developers → Webhooks → this endpoint → recent deliveries), confirm a `payment_intent.payment_failed` event was delivered and the app responded `200`.

Then find the order id (the `attemptId` — visible in the browser's `localStorage.getItem('acc_checkout_attempt_v1')`, or in the `/api/checkout` request body in the Network tab) and run:

```bash
npm run orders -- get <order-id>
```

Expected: `status: pending` — NOT `failed`. This is the core fix; before it, this order would already show `status: failed` at this point.

- [ ] **Step 4: Retry with a valid card on the same PaymentIntent**

Without reloading the page, submit the Payment Element again using Stripe's success test card `4242424242424242`.
Expected: the browser navigates to `/koszyk/return` showing a success state.

- [ ] **Step 5: Confirm the order completed correctly**

```bash
npm run orders -- get <order-id>
```

Expected: `status: paid`, `paid_at` set, and — within a few seconds — `confirmation_email_sent_at` set (the studio + customer emails fired). Before this fix, `status` would have stayed `failed` and none of this would have happened despite the payment succeeding.

- [ ] **Step 6: Confirm no false-positive alert fired**

Check Sentry (or local console/dev-server output) for `stripe_webhook_succeeded_on_dead_order`. Expected: **not present** for this run — this is the legitimate-retry path Task 1 fixed, not the anomalous dead-order path Task 2 alerts on.

- [ ] **Step 7: Record the result**

Note the outcome (pass/fail, with the order id and any Sentry links) in the PR description when this plan's branch is opened for review. No commit for this task — it is verification only.

---

## Self-Review Notes

- **Coverage:** F-01's core bug (same-PI retry after decline silently drops the order) → Task 1. The audit's explicit second recommendation ("markPaid's succeeded path on a failed/expired order should alert in Sentry and/or refund, never end silently") → Task 2 (alert chosen over auto-refund: refunding blind on every occurrence risks reversing a legitimate, correctly-completed transaction if the order state read is stale or the anomaly is benign — a human should look first, especially now that Task 1 makes this path rare). The audit's stated unverified assumption (Stripe's actual `payment_failed` semantics on a real test account) → Task 3.
- **Placeholder scan:** no TBD/TODO; every step shows exact before/after code, exact commands, and exact expected output.
- **Cross-file consistency:** Task 1 explicitly sequences the `webhook.ts` change (Steps 1-4) before revealing and fixing the now-stale `route.test.ts` fixtures (Steps 5-7) — this is not two independent changes, it's one behavior change with two test surfaces (unit-level dispatch test, and route-level integration test), and skipping the second half would leave the suite red.
- **Type consistency:** `existing.status` is read as the same inline string union (`'pending' | 'paid' | 'failed' | 'expired' | 'refunded'`) used throughout `route.ts` — no new type introduced, matching the file's existing convention of untyped `.from('orders')` casts (confirmed: no generated Supabase types file exists in this repo).
- **Out of scope (tracked in the audit but not this plan):** F-18 (a `webhook_events` ledger table for Stripe, mirroring the one Prodigi already uses) — the audit lists this as a separate architecture-refactor item (its own remediation tier), not required to close F-01.
