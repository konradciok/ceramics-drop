# Server-Side Conversions Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server-side Meta CAPI / GA4 MP purchase conversion resilient (bounded, alerted-on-failure, sent at most once per order) and add the missing GA4 `refund` event so GA4 revenue is corrected when an order is fully refunded.

**Architecture:** Three independent, additive hardenings to the existing `trackPurchase`/`releaseSale` dependency implementations in `src/app/api/stripe/webhook/route.ts`, none of which change `sendPurchaseConversions`'s "never throws" contract (it stays a best-effort safety net, never allowed to block fulfilment): (1) an 8-second `AbortSignal` timeout on the two outbound HTTP calls, (2) a claim-once `orders.conversions_sent_at` column so a Stripe webhook redelivery can't double-send past Meta's ~48h dedup window, and (3) a new GA4-only `refund` event fired from the one branch in `releaseSale` that represents a real paid→refunded transition.

**Tech Stack:** Next.js 16 App Router (Cloudflare Workers), TypeScript, Supabase, Vitest.

## Global Constraints

- Source audit: `docs/audits/event-system-audit.md`, findings F-05, F-06, F-08 (all **Medium**).
- Test runner is Vitest: `npx vitest run <path>` (never jest).
- One new migration: `orders.conversions_sent_at TIMESTAMPTZ`, nullable, no default — mirrors the existing `confirmation_email_sent_at`/`studio_email_sent_at` columns exactly.
- No new npm dependencies. `AbortSignal.timeout(ms)` is a native Web API already available on the Cloudflare Workers runtime — do not add a userland abort/timeout library.
- Every new code path in `trackPurchase`/`releaseSale`/`sendRefundConversion` must stay best-effort: wrapped in try/catch, logged + `Sentry.captureException`/`captureMessage` on failure, and must never throw in a way that blocks fulfilment or the webhook's 200 response.
- Commit after each task. Run the **full** `route.test.ts` file (not a filtered subset) after every step that touches `src/app/api/stripe/webhook/route.ts` — it has ~20 other cases (refund/dispute convergence, under-fulfilment, email claims) that must not regress.

---

### Task 1: Add a request timeout to Meta CAPI and GA4 MP (F-06, part 1)

**Files:**
- Modify: `src/lib/marketing/meta-capi.ts`
- Test: `src/lib/marketing/meta-capi.test.ts`
- Modify: `src/lib/marketing/ga4-mp.ts`
- Test: `src/lib/marketing/ga4-mp.test.ts`

**Interfaces:**
- Consumes: nothing new — both `sendMetaPurchase`/`sendGa4Purchase` already accept an injectable `fetchImpl: typeof fetch = fetch` last parameter, so no signature change is needed to add a timeout.
- Produces: no new exports. Both functions now pass `signal: AbortSignal.timeout(8000)` in the `fetch` init.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/marketing/meta-capi.test.ts`, inside the existing `describe('sendMetaPurchase', ...)` block:

```ts
  it('bounds the request with an 8s abort signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    await sendMetaPurchase({ pixelId: 'PIX', accessToken: 'TOK' }, input(), fetchImpl);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
```

Add to `src/lib/marketing/ga4-mp.test.ts`, inside the existing `describe('sendGa4Purchase', ...)` block:

```ts
  it('bounds the request with an 8s abort signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    await sendGa4Purchase({ measurementId: 'G-X', apiSecret: 'S' }, input(), fetchImpl);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/marketing/meta-capi.test.ts src/lib/marketing/ga4-mp.test.ts -t "abort signal"`
Expected: FAIL both — today's `fetchImpl` calls pass no `signal` at all, so `init.signal` is `undefined`.

- [ ] **Step 3: Add the timeout**

In `src/lib/marketing/meta-capi.ts`, replace:

```ts
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
```

with:

```ts
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
```

In `src/lib/marketing/ga4-mp.ts`, replace:

```ts
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildGa4PurchasePayload(input)),
  });
```

with:

```ts
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildGa4PurchasePayload(input)),
    signal: AbortSignal.timeout(8000),
  });
```

- [ ] **Step 4: Run both test files to verify they pass**

Run: `npx vitest run src/lib/marketing/meta-capi.test.ts src/lib/marketing/ga4-mp.test.ts`
Expected: PASS — all cases, including the pre-existing ones (none of them assert exact equality on the full `fetch` `init` object, so adding a `signal` key doesn't break them).

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/meta-capi.ts src/lib/marketing/meta-capi.test.ts src/lib/marketing/ga4-mp.ts src/lib/marketing/ga4-mp.test.ts
git commit -m "fix(marketing): bound Meta CAPI and GA4 MP requests with an 8s timeout"
```

---

### Task 2: Alert instead of silently dropping conversions on a transient order-lookup failure (F-06, part 2)

**Files:**
- Modify: `src/app/api/stripe/webhook/route.ts`
- Test: `src/app/api/stripe/webhook/route.test.ts`

**Interfaces:**
- Consumes: `Sentry.captureMessage` (already imported).
- Produces: no new exports. Makes the Cloudflare-env mock in `route.test.ts` mutable (`let cfEnv`) so a describe block can opt a test into GA4 credentials without affecting the rest of the suite (which relies on `trackPurchase` no-op'ing with no credentials configured) — this is reused by Task 3.

- [ ] **Step 1: Make the Cloudflare env mock mutable**

In `src/app/api/stripe/webhook/route.test.ts`, replace:

```ts
// --- Cloudflare env (webhook secret + no conversion creds so trackPurchase no-ops) ---
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: { STRIPE_WEBHOOK_SECRET: 'whsec_test' } }),
}));
```

with:

```ts
// --- Cloudflare env: mutable per-test so specific describe blocks can opt into
// conversion credentials (GA4/Meta) without affecting the rest of the suite,
// which relies on trackPurchase no-op'ing with no creds configured. ---
let cfEnv: Record<string, string | undefined> = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: cfEnv }),
}));
```

Add a new import (needed so a test can give `sendPurchaseConversions` a one-off implementation that exercises the real `loadOrder` closure route.ts builds — today the file only `vi.mock`s this module, it never imports the mocked binding). Add this line alongside the other `@/lib/...` imports (e.g. next to `import { sendPurchasedEvent } from '@/lib/resend-events';`):

```ts
import { sendPurchaseConversions } from '@/lib/marketing/conversions';
```

- [ ] **Step 2: Extend the `makeSucceededSupabase` fixture for the conversions `loadOrder` select**

In `src/app/api/stripe/webhook/route.test.ts`, replace the `makeSucceededSupabase` options type:

```ts
function makeSucceededSupabase(opts: {
  casUpdate: QueryResult;
  fallbackSelect?: QueryResult;
  shipmentLookup: QueryResult;
  soldCount?: QueryResult;
  ceramicCount?: QueryResult;
  variantRows?: QueryResult;
  /** The `id, email, ... , confirmation_email_sent_at, studio_email_sent_at` load. */
  emailOrderSelect?: QueryResult;
  /** Result of the atomic `studio_email_sent_at IS NULL` claim UPDATE. */
  studioClaim?: QueryResult;
  /** Result of the atomic `confirmation_email_sent_at IS NULL` claim UPDATE. */
  confirmClaim?: QueryResult;
}) {
```

with:

```ts
function makeSucceededSupabase(opts: {
  casUpdate: QueryResult;
  fallbackSelect?: QueryResult;
  shipmentLookup: QueryResult;
  soldCount?: QueryResult;
  ceramicCount?: QueryResult;
  variantRows?: QueryResult;
  /** The `id, email, ... , confirmation_email_sent_at, studio_email_sent_at` load. */
  emailOrderSelect?: QueryResult;
  /** Result of the atomic `studio_email_sent_at IS NULL` claim UPDATE. */
  studioClaim?: QueryResult;
  /** Result of the atomic `confirmation_email_sent_at IS NULL` claim UPDATE. */
  confirmClaim?: QueryResult;
  /** The conversions `loadOrder` select (`id, payment_intent_id, status, subtotal, ...`). */
  conversionsOrderSelect?: QueryResult;
}) {
```

And replace the `orders.select` handler:

```ts
          select: (columns: string) => {
            if (columns === 'id, status, private_sale_id') return proxyChain(opts.fallbackSelect ?? { data: null, error: null });
            if (columns === 'id, status') return proxyChain(opts.shipmentLookup);
            if (columns.startsWith('id, email')) return proxyChain(opts.emailOrderSelect ?? { data: null, error: null });
            throw new Error(`unexpected orders.select columns: ${columns}`);
          },
```

with:

```ts
          select: (columns: string) => {
            if (columns === 'id, status, private_sale_id') return proxyChain(opts.fallbackSelect ?? { data: null, error: null });
            if (columns === 'id, status') return proxyChain(opts.shipmentLookup);
            if (columns.startsWith('id, email')) return proxyChain(opts.emailOrderSelect ?? { data: null, error: null });
            if (columns.startsWith('id, payment_intent_id')) return proxyChain(opts.conversionsOrderSelect ?? { data: null, error: null });
            throw new Error(`unexpected orders.select columns: ${columns}`);
          },
```

- [ ] **Step 3: Write the failing test**

Add a new describe block after `describe('webhook markPaid unknown payment_intent (F9b)', ...)`:

```ts
describe('webhook trackPurchase loadOrder failure alert (F-06)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test', GA4_API_SECRET: 'ga4_secret_test' };
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-TEST';
  });
  afterEach(() => {
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  });

  it('a transient error loading the order for conversions is alerted, not silently dropped', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Exercise the real loadOrder closure route.ts builds and passes as a dep,
    // without needing the real sendPurchaseConversions (and its Meta/GA4 HTTP
    // calls) — mirrors how ConversionsDeps.loadOrder is designed to be injected.
    vi.mocked(sendPurchaseConversions).mockImplementationOnce(async (pi, deps) => {
      await deps.loadOrder(pi);
    });
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      variantRows: { data: [], error: null },
      conversionsOrderSelect: { data: null, error: { code: '500', message: 'connection reset' } },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('conversions_load_order_failed', {
      level: 'warning',
      extra: { payment_intent_id: 'pi_1', error: 'connection reset' },
    });
    consoleErrorSpy.mockRestore();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts -t "loadOrder failure alert"`
Expected: FAIL — today's `loadOrder` destructures only `{ data }` (drops `error` entirely) and returns `null` with zero logging when `data` is falsy.

- [ ] **Step 5: Fix `loadOrder` to alert instead of silently swallowing**

In `src/app/api/stripe/webhook/route.ts`, inside the `trackPurchase` deps implementation, replace:

```ts
          loadOrder: async (paymentIntentId) => {
            const { data } = await supabase
              .from('orders')
              .select(
                'id, payment_intent_id, status, subtotal, shipping, total, currency, email, ' +
                  'receiver_first_name, receiver_last_name, receiver_phone, shipping_address, marketing',
              )
              .eq('payment_intent_id', paymentIntentId)
              .single();
            if (!data) return null;
            const orderRow = data as unknown as { id: string } & Omit<ConversionOrder, 'items'>;
            const { data: itemRows } = await supabase
              .from('order_items')
              .select('product_id, unit_price')
              .eq('order_id', orderRow.id);
            return {
              ...orderRow,
              items: (itemRows as ConversionOrder['items'] | null) ?? [],
            };
          },
```

with:

```ts
          loadOrder: async (paymentIntentId) => {
            const { data, error } = await supabase
              .from('orders')
              .select(
                'id, payment_intent_id, status, subtotal, shipping, total, currency, email, ' +
                  'receiver_first_name, receiver_last_name, receiver_phone, shipping_address, marketing',
              )
              .eq('payment_intent_id', paymentIntentId)
              .single();
            if (error || !data) {
              // markPaid already ran by this point (trackPurchase fires right after
              // it — see webhook.ts), so the order must exist; any miss here is a
              // transient DB hiccup, not a genuine unknown PI. The old code silently
              // returned null, dropping the server-side conversion with zero trace.
              console.error('conversions loadOrder failed for', paymentIntentId, error);
              Sentry.captureMessage('conversions_load_order_failed', {
                level: 'warning',
                extra: { payment_intent_id: paymentIntentId, error: error?.message ?? null },
              });
              return null;
            }
            const orderRow = data as unknown as { id: string } & Omit<ConversionOrder, 'items'>;
            const { data: itemRows } = await supabase
              .from('order_items')
              .select('product_id, unit_price')
              .eq('order_id', orderRow.id);
            return {
              ...orderRow,
              items: (itemRows as ConversionOrder['items'] | null) ?? [],
            };
          },
```

- [ ] **Step 6: Run the full route test file to verify it passes**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts`
Expected: PASS — all cases.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/stripe/webhook/route.ts src/app/api/stripe/webhook/route.test.ts
git commit -m "fix(webhook): alert via Sentry when the conversions order lookup fails"
```

---

### Task 3: Claim `conversions_sent_at` so a webhook redelivery can't double-send (F-05)

**Files:**
- Create: `supabase/migrations/20260726120000_orders_conversions_sent_at.sql`
- Modify: `src/app/api/stripe/webhook/route.ts`
- Test: `src/app/api/stripe/webhook/route.test.ts`
- Test: `src/lib/webhook.test.ts` (rename for accuracy — no behavior change)

**Interfaces:**
- Consumes: the mutable `cfEnv` and `sendPurchaseConversions` import from Task 2.
- Produces: `orders.conversions_sent_at` column. `trackPurchase` now claims it (single `UPDATE ... WHERE IS NULL`, no retry loop, no release-on-failure — unlike the email claim helper, `sendPurchaseConversions` never throws, so there is nothing to "release on failure"; the accepted trade-off, same as the audit's own note, is a narrow loss window if the process crashes between claim and send).

- [ ] **Step 1: Create the migration**

```sql
-- supabase/migrations/20260726120000_orders_conversions_sent_at.sql
-- Claim column so server-side purchase conversions (Meta CAPI + GA4 MP) are sent
-- at most once per order. Closes the gap where a payment_intent.succeeded
-- redelivery (Stripe retries up to 3 days if a later step in the same handler
-- throws) re-sends past Meta's ~48h event_id dedup window, double-counting the
-- conversion. Mirrors orders.confirmation_email_sent_at / studio_email_sent_at.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS conversions_sent_at TIMESTAMPTZ;
```

- [ ] **Step 2: Extend the `makeSucceededSupabase` fixture for the claim UPDATE**

In `src/app/api/stripe/webhook/route.test.ts`, add to the `makeSucceededSupabase` options type (after `conversionsOrderSelect` from Task 2):

```ts
  /** Result of the atomic `conversions_sent_at IS NULL` claim UPDATE. */
  conversionsClaim?: QueryResult;
```

Add a new branch to the `orders.update` handler, immediately before the final `throw new Error(...)`:

```ts
            if ('conversions_sent_at' in payload) {
              return proxyChain(opts.conversionsClaim ?? { data: [], error: null });
            }
```

- [ ] **Step 3: Write the failing tests**

Add a new describe block:

```ts
describe('webhook trackPurchase conversions claim (F-05)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(sendPurchaseConversions).mockClear();
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test', GA4_API_SECRET: 'ga4_secret_test' };
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-TEST';
  });
  afterEach(() => {
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  });

  it('first delivery: claims conversions_sent_at and sends', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      variantRows: { data: [], error: null },
      conversionsClaim: { data: [{ id: 'o1' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(sendPurchaseConversions).toHaveBeenCalledTimes(1);
  });

  it('redelivery after conversions already claimed: does not send again', async () => {
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [], error: null },
      fallbackSelect: { data: { id: 'o1', status: 'paid', private_sale_id: null }, error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      variantRows: { data: [], error: null },
      conversionsClaim: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200);
    expect(sendPurchaseConversions).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts -t "conversions claim"`
Expected: both FAIL — today there is no claim UPDATE at all, so `sendPurchaseConversions` is called unconditionally on every delivery (the first test would pass by coincidence, but the second — "does not send again" — fails, since nothing today prevents a redelivery from sending again).

- [ ] **Step 5: Add the claim to `trackPurchase`**

In `src/app/api/stripe/webhook/route.ts`, inside the `trackPurchase` deps implementation, replace:

```ts
        if (!metaConfig && !ga4Config) return;

        await sendPurchaseConversions(pi, {
```

with:

```ts
        if (!metaConfig && !ga4Config) return;

        // Claim before sending: at-least-once webhook delivery means Stripe can
        // redeliver payment_intent.succeeded (e.g. a later step in this same
        // handler throws) well past Meta's ~48h event_id dedup window, which
        // would double-count the conversion. One order = one attempt; if the
        // send itself fails after this point, recovery is a manual column reset
        // (same trade-off already accepted for the email claim columns below).
        const { data: claimed, error: claimErr } = await supabase
          .from('orders')
          .update({ conversions_sent_at: new Date().toISOString() })
          .eq('payment_intent_id', pi)
          .is('conversions_sent_at', null)
          .select('id');
        if (claimErr) {
          console.error('conversions_sent_at claim failed for', pi, claimErr);
          return;
        }
        if (!claimed || claimed.length === 0) return;

        await sendPurchaseConversions(pi, {
```

- [ ] **Step 6: Run the full route test file to verify it passes**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts`
Expected: PASS — all cases.

- [ ] **Step 7: Clarify the now-partially-stale dedup test name in `webhook.test.ts`**

The dispatch-level test's name currently implies vendor-side `event_id` dedup is the *only* protection — after this task that's no longer true (the real protection is now the claim column, one layer down in `route.ts`). The assertion itself doesn't change (dispatch still calls `trackPurchase` unconditionally), only the name/framing.

Replace:

```ts
  it('already processed (not a new sale): still fires trackPurchase (conversions dedup via event_id)', async () => {
    const d = deps({ markPaid: vi.fn().mockResolvedValue(false) });
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.trackPurchase).toHaveBeenCalledWith('pi_1');
  });
```

with:

```ts
  it('already processed (not a new sale): still calls trackPurchase — the redelivery-dedup claim lives inside the trackPurchase implementation (route.ts), not at this dispatch level', async () => {
    const d = deps({ markPaid: vi.fn().mockResolvedValue(false) });
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.trackPurchase).toHaveBeenCalledWith('pi_1');
  });
```

Run: `npx vitest run src/lib/webhook.test.ts`
Expected: PASS (no behavior change, name only).

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260726120000_orders_conversions_sent_at.sql src/app/api/stripe/webhook/route.ts src/app/api/stripe/webhook/route.test.ts src/lib/webhook.test.ts
git commit -m "fix(webhook): claim conversions_sent_at so a redelivery can't double-send a purchase conversion"
```

---

### Task 4: Fire a GA4 `refund` event on a real refund (F-08)

**Files:**
- Modify: `src/lib/marketing/ga4-mp.ts`
- Test: `src/lib/marketing/ga4-mp.test.ts`
- Modify: `src/lib/marketing/conversions.ts`
- Test: `src/lib/marketing/conversions.test.ts`
- Modify: `src/app/api/stripe/webhook/route.ts`
- Test: `src/app/api/stripe/webhook/route.test.ts`

**Interfaces:**
- Produces: `Ga4RefundInput`, `buildGa4RefundPayload(input): object`, `sendGa4Refund(config, input, fetchImpl?): Promise<{ok, status?, skipped?, errorBody?}>` from `ga4-mp.ts`. `RefundOrder`, `RefundConversionsDeps`, `sendRefundConversion(order, deps): Promise<void>` from `conversions.ts`.
- Consumes (in `route.ts`): `sendRefundConversion`, `type MarketingContext` from `@/lib/marketing/context`.

- [ ] **Step 1: Write the failing tests for the GA4 refund primitives**

Add to `src/lib/marketing/ga4-mp.test.ts`:

```ts
describe('buildGa4RefundPayload', () => {
  it('builds a refund event keyed by transaction_id, mirroring purchase value/shipping', () => {
    const p = buildGa4RefundPayload({
      clientId: '111.222',
      sessionId: '999',
      transactionId: 'pi_1',
      value: 300,
      shipping: 18,
      currency: 'PLN',
    });
    expect(p.client_id).toBe('111.222');
    expect(p.events[0].name).toBe('refund');
    expect(p.events[0].params).toMatchObject({
      transaction_id: 'pi_1', value: 300, shipping: 18, currency: 'PLN', session_id: '999',
    });
  });
});

describe('sendGa4Refund', () => {
  it('skips (returns skipped) when clientId is missing', async () => {
    const fetchImpl = vi.fn();
    const res = await sendGa4Refund(
      { measurementId: 'G-X', apiSecret: 'S' },
      { clientId: null, transactionId: 'pi_1', value: 300, shipping: 18, currency: 'PLN' },
      fetchImpl,
    );
    expect(res).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs to /mp/collect with a refund event', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    const res = await sendGa4Refund(
      { measurementId: 'G-X', apiSecret: 'S' },
      { clientId: '111.222', transactionId: 'pi_1', value: 300, shipping: 18, currency: 'PLN' },
      fetchImpl,
    );
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://www.google-analytics.com/mp/collect');
    expect(JSON.parse(init.body).events[0].name).toBe('refund');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/marketing/ga4-mp.test.ts -t "Ga4Refund"`
Expected: FAIL — `buildGa4RefundPayload`/`sendGa4Refund` don't exist yet (import error).

- [ ] **Step 3: Implement the GA4 refund primitives**

Append to `src/lib/marketing/ga4-mp.ts` (after `sendGa4Purchase`):

```ts
export type Ga4RefundInput = {
  clientId: string | null;
  sessionId?: string | null;
  transactionId: string;
  value: number;     // major units (PLN), item subtotal — mirrors Ga4PurchaseInput.value
  shipping: number;  // major units (PLN) — mirrors Ga4PurchaseInput.shipping
  currency: string;
};

export function buildGa4RefundPayload(input: Ga4RefundInput) {
  return {
    client_id: input.clientId,
    events: [
      {
        name: 'refund',
        params: {
          transaction_id: input.transactionId,
          currency: input.currency,
          value: input.value,
          shipping: input.shipping,
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
          engagement_time_msec: 1,
        },
      },
    ],
  };
}

export async function sendGa4Refund(
  config: Ga4Config,
  input: Ga4RefundInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number; skipped?: boolean; errorBody?: string }> {
  if (!input.clientId) return { ok: false, skipped: true };
  const url =
    `https://www.google-analytics.com/mp/collect` +
    `?measurement_id=${encodeURIComponent(config.measurementId)}` +
    `&api_secret=${encodeURIComponent(config.apiSecret)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildGa4RefundPayload(input)),
    signal: AbortSignal.timeout(8000),
  });
  if (res.ok) return { ok: true, status: res.status };
  const errorBody = await res.text().catch(() => undefined);
  return { ok: false, status: res.status, errorBody: errorBody?.slice(0, 2000) };
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/lib/marketing/ga4-mp.test.ts`
Expected: PASS — all cases, including Task 1's timeout tests and `sendGa4Purchase`'s pre-existing cases.

- [ ] **Step 5: Write the failing tests for `sendRefundConversion`**

Add to `src/lib/marketing/conversions.test.ts` (extend the existing import line to add `sendRefundConversion` and `type RefundOrder`):

```ts
describe('sendRefundConversion', () => {
  const baseRefundOrder = (over: Partial<RefundOrder> = {}): RefundOrder => ({
    payment_intent_id: 'pi_1',
    subtotal: 30000,
    shipping: 1800,
    currency: 'pln',
    marketing: {
      consent: 'granted', fbp: null, fbc: null, ga_client_id: '111.222', ga_session_id: '999',
      ip: null, user_agent: null, event_source_url: null, captured_at: '2026-06-09T00:00:00Z',
    },
    ...over,
  });

  it('sends a GA4 refund event mirroring the purchase value/shipping', async () => {
    const sendGa4RefundMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await sendRefundConversion(baseRefundOrder(), {
      ga4Config: { measurementId: 'G-X', apiSecret: 'S' },
      sendGa4Refund: sendGa4RefundMock,
    });
    expect(sendGa4RefundMock).toHaveBeenCalledWith(
      { measurementId: 'G-X', apiSecret: 'S' },
      { clientId: '111.222', sessionId: '999', transactionId: 'pi_1', value: 300, shipping: 18, currency: 'PLN' },
    );
  });

  it('does nothing when consent is not granted', async () => {
    const sendGa4RefundMock = vi.fn();
    const denied = baseRefundOrder();
    await sendRefundConversion({ ...denied, marketing: { ...denied.marketing!, consent: 'denied' } }, {
      ga4Config: { measurementId: 'G-X', apiSecret: 'S' },
      sendGa4Refund: sendGa4RefundMock,
    });
    expect(sendGa4RefundMock).not.toHaveBeenCalled();
  });

  it('does nothing when GA4 is not configured', async () => {
    const sendGa4RefundMock = vi.fn();
    await sendRefundConversion(baseRefundOrder(), { sendGa4Refund: sendGa4RefundMock });
    expect(sendGa4RefundMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/lib/marketing/conversions.test.ts -t "sendRefundConversion"`
Expected: FAIL — `sendRefundConversion`/`RefundOrder` don't exist yet (import error).

- [ ] **Step 7: Implement `sendRefundConversion`**

In `src/lib/marketing/conversions.ts`, extend the GA4 import at the top of the file:

Replace:

```ts
import { sendGa4Purchase, type Ga4Config, type Ga4PurchaseInput } from './ga4-mp';
```

with:

```ts
import { sendGa4Purchase, sendGa4Refund, type Ga4Config, type Ga4PurchaseInput, type Ga4RefundInput } from './ga4-mp';
```

Append to the end of the file, before the `export { sha256Hex };` re-export line:

```ts
export type RefundOrder = {
  payment_intent_id: string;
  subtotal: number; // grosze
  shipping: number;  // grosze
  currency: string;
  marketing: MarketingContext | null;
};

export type RefundConversionsDeps = {
  ga4Config?: Ga4Config;
  sendGa4Refund?: typeof sendGa4Refund;
};

/**
 * GA4-only: Meta doesn't support un-firing a conversion. Fires only for a real
 * paid→refunded transition (see releaseSale in route.ts) — never for the
 * pending→refunded race, since no purchase was ever recorded as revenue there.
 */
export async function sendRefundConversion(
  order: RefundOrder,
  deps: RefundConversionsDeps,
): Promise<void> {
  if (!order.marketing || order.marketing.consent !== 'granted') return;
  if (!deps.ga4Config) return;

  const send = deps.sendGa4Refund ?? sendGa4Refund;
  const refundInput: Ga4RefundInput = {
    clientId: order.marketing.ga_client_id,
    sessionId: order.marketing.ga_session_id,
    transactionId: order.payment_intent_id,
    value: order.subtotal / 100,
    shipping: order.shipping / 100,
    currency: order.currency.toUpperCase(),
  };

  try {
    const result = await send(deps.ga4Config, refundInput);
    if (result.skipped) {
      console.warn('ga4 mp refund skipped (consent granted, no clientId) for', order.payment_intent_id);
      return;
    }
    if (!result.ok) {
      console.error('ga4 mp refund http error for', order.payment_intent_id, result.status, result.errorBody);
      Sentry.captureMessage(`ga4 mp refund http error ${result.status}`, {
        level: 'error',
        fingerprint: ['ga4-mp-refund-http-error', String(result.status), result.errorBody ?? ''],
        extra: { payment_intent_id: order.payment_intent_id, status: result.status, response_body: result.errorBody },
      });
    }
  } catch (err) {
    console.error('ga4 mp refund failed for', order.payment_intent_id, err);
    Sentry.captureException(err);
  }
}
```

- [ ] **Step 8: Run the test file to verify it passes**

Run: `npx vitest run src/lib/marketing/conversions.test.ts`
Expected: PASS — all cases, including the pre-existing `sendPurchaseConversions` suite.

- [ ] **Step 9: Write the failing route-level test**

In `src/app/api/stripe/webhook/route.test.ts`, extend the conversions mock and import:

Replace:

```ts
vi.mock('@/lib/marketing/conversions', () => ({ sendPurchaseConversions: vi.fn() }));
```

with:

```ts
vi.mock('@/lib/marketing/conversions', () => ({ sendPurchaseConversions: vi.fn(), sendRefundConversion: vi.fn() }));
```

Replace:

```ts
import { sendPurchaseConversions } from '@/lib/marketing/conversions';
```

with:

```ts
import { sendPurchaseConversions, sendRefundConversion } from '@/lib/marketing/conversions';
```

Add a new describe block:

```ts
describe('webhook releaseSale GA4 refund conversion (F-08)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(sendRefundConversion).mockClear();
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test', GA4_API_SECRET: 'ga4_secret_test' };
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-TEST';
  });
  afterEach(() => {
    cfEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  });

  it('paid→refunded transition: sends a GA4 refund event when consent was granted', async () => {
    const { supabase } = makeSupabase({
      ordersUpdate: [
        { data: [], error: null }, // pending→refunded CAS: no match (order was paid)
        {
          data: [{
            id: 'o1',
            private_sale_id: null,
            subtotal: 30000,
            shipping: 1800,
            currency: 'pln',
            marketing: {
              consent: 'granted', ga_client_id: '111.222', ga_session_id: '999',
              fbp: null, fbc: null, ip: null, user_agent: null, event_source_url: null, captured_at: '2026-06-09T00:00:00Z',
            },
          }], error: null,
        }, // paid→refunded CAS: matches
      ],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    expect(sendRefundConversion).toHaveBeenCalledWith(
      {
        payment_intent_id: 'pi_1',
        subtotal: 30000,
        shipping: 1800,
        currency: 'pln',
        marketing: {
          consent: 'granted', ga_client_id: '111.222', ga_session_id: '999',
          fbp: null, fbc: null, ip: null, user_agent: null, event_source_url: null, captured_at: '2026-06-09T00:00:00Z',
        },
      },
      { ga4Config: { measurementId: 'G-TEST', apiSecret: 'ga4_secret_test' } },
    );
  });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts -t "GA4 refund conversion"`
Expected: FAIL — `releaseSale` doesn't call `sendRefundConversion` yet, and its `orders.update().select(...)` doesn't request `subtotal`/`shipping`/`currency`/`marketing` yet.

- [ ] **Step 11: Wire `sendRefundConversion` into `releaseSale`**

In `src/app/api/stripe/webhook/route.ts`, add imports:

Replace:

```ts
import { sendPurchaseConversions, type ConversionOrder } from '@/lib/marketing/conversions';
```

with:

```ts
import { sendPurchaseConversions, sendRefundConversion, type ConversionOrder } from '@/lib/marketing/conversions';
import type { MarketingContext } from '@/lib/marketing/context';
```

Inside `releaseSale`, replace:

```ts
      const { data, error: ordersErr } = await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('payment_intent_id', pi)
        .eq('status', 'paid')
        .select('id, private_sale_id');
      if (ordersErr) throw new Error(`releaseSale orders update failed: ${ordersErr.message}`);
      const rows = data as Array<{ id: string; private_sale_id: string | null }> | null;
      if (rows && rows.length > 0) {
        // Print orders: stop the Prodigi side (cancel or alert). Runs only when
        // the paid→refunded CAS actually flipped, so a replayed event can't
        // re-enter. Best-effort — never throws.
        await cancelPrintFulfilment(rows[0].id, env);
        // Private-sale pieces were sold privately (already hidden from the shop) and must
        // stay `sold` on refund — skip the relist write entirely. Normal refunds relist.
        if (releaseTargetStatus(rows[0]) === 'sold') return true;
```

with:

```ts
      const { data, error: ordersErr } = await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('payment_intent_id', pi)
        .eq('status', 'paid')
        .select('id, private_sale_id, subtotal, shipping, currency, marketing');
      if (ordersErr) throw new Error(`releaseSale orders update failed: ${ordersErr.message}`);
      const rows = data as Array<{
        id: string;
        private_sale_id: string | null;
        subtotal: number;
        shipping: number;
        currency: string;
        marketing: MarketingContext | null;
      }> | null;
      if (rows && rows.length > 0) {
        // Print orders: stop the Prodigi side (cancel or alert). Runs only when
        // the paid→refunded CAS actually flipped, so a replayed event can't
        // re-enter. Best-effort — never throws.
        await cancelPrintFulfilment(rows[0].id, env);
        // GA4 revenue correction: this order WAS recorded as purchase revenue
        // (it was 'paid'), so a full refund must reverse it. Same real-transition
        // scoping as cancelPrintFulfilment above — never fires on the
        // pending→refunded or already-refunded branches, since no purchase was
        // ever recorded there.
        const ga4Secret = env.GA4_API_SECRET;
        const measurementId = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
        await sendRefundConversion(
          { payment_intent_id: pi, subtotal: rows[0].subtotal, shipping: rows[0].shipping, currency: rows[0].currency, marketing: rows[0].marketing },
          { ga4Config: ga4Secret && measurementId ? { measurementId, apiSecret: ga4Secret } : undefined },
        );
        // Private-sale pieces were sold privately (already hidden from the shop) and must
        // stay `sold` on refund — skip the relist write entirely. Normal refunds relist.
        if (releaseTargetStatus(rows[0]) === 'sold') return true;
```

- [ ] **Step 12: Run the full route test file to verify it passes**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts`
Expected: PASS — all cases, including the existing `describe('webhook releaseSale (F2)', ...)` and dispute-closed tests (which don't set `marketing`/`subtotal`/`shipping`/`currency` in their fixtures — `sendRefundConversion` no-ops safely on the falsy `marketing` check in that case, so they're unaffected).

- [ ] **Step 13: Commit**

```bash
git add src/lib/marketing/ga4-mp.ts src/lib/marketing/ga4-mp.test.ts src/lib/marketing/conversions.ts src/lib/marketing/conversions.test.ts src/app/api/stripe/webhook/route.ts src/app/api/stripe/webhook/route.test.ts
git commit -m "feat(marketing): fire a GA4 refund event to correct revenue on a full refund"
```

---

## Self-Review Notes

- **Coverage:** F-06 (timeout) → Task 1. F-06 (silent conversions-load failure) → Task 2. F-05 (redelivery double-send) → Task 3. F-08 (GA4 refund event) → Task 4.
- **Placeholder scan:** no TBD/TODO; every step shows exact before/after code and exact commands/expected output.
- **Design note on F-05's scope:** the claim intentionally has no release-on-failure branch, unlike the email claim helper (`sendEmailOnceWithClaim`) — `sendPurchaseConversions` is designed to never throw (Meta/GA4 failures are logged + Sentried internally so a conversions outage can never block fulfilment), so a release-on-failure branch modeled on the email pattern would never actually trigger. The accepted trade-off (a claim that sticks if the process crashes between claim and send) is the same one the audit itself documents for the email pattern, just without the dead retry-loop code copied over unnecessarily.
- **Design note on F-08's scope:** the refund conversion is placed inside `releaseSale`'s `paid→refunded` branch specifically — not the `pending→refunded` branch (no purchase was ever recorded as GA4 revenue there, so there's nothing to reverse) and not the already-refunded crash-resume branch (would double-fire the reversal on every redelivery).
- **Type consistency:** `RefundOrder`'s fields (`payment_intent_id`, `subtotal`, `shipping`, `currency`, `marketing`) match exactly what Task 4's `route.ts` change selects and passes in Step 11.
- **Out of scope (tracked in the audit but not this plan):** F-22 (GA4's `value` convention excluding shipping, inconsistent with Meta) — the refund event in this plan deliberately mirrors whatever convention `sendPurchaseConversions` already uses today, so it stays parallel if F-22 is addressed later; redesigning the convention itself is a separate, Low-priority audit item.
