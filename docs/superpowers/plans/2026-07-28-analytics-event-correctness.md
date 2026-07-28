# Analytics Event Correctness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix payload/dedup defects — symmetric client/server purchase items, currency on demand events, one `begin_checkout` per attempt, honest newsletter counting, and Sentry on `cart.purchased` failure.

**Architecture:** Client analytics is a single typed builder layer (`src/lib/analytics.ts`) feeding `pushDataLayer()` → `window.dataLayer` → GTM → GA4/Meta; server-side purchase/refund conversions go **direct** to GA4 Measurement Protocol + Meta CAPI from the Stripe webhook via `src/lib/marketing/`. The browser `purchase` and the server GA4 MP `purchase` share a deterministic key (`transaction_id = <payment_intent_id>`), so GA4 deduplicates them and keeps whichever hit lands first. These five fixes correct payload symmetry, per-attempt dedup, currency labelling, honest newsletter counting, and one observability gap — **no transport or architecture change**.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, GA4 Measurement Protocol, Cloudflare Workers.

## Global Constraints
- Build MUST stay `next build --webpack` — never Turbopack.
- All analytics events go through `pushDataLayer()` in `src/lib/analytics.ts`; never call `gtag()`/`fbq()` directly in `src/`.
- Analytics uses MAJOR currency units; display currency comes from `useCurrency()` (client) / `orders.currency` (server), not the locale. Every monetary param needs a `currency` sibling.
- Deterministic purchase key `event_id = purchase-<payment_intent_id>` / `transaction_id = <payment_intent_id>` — client and server MUST stay identical; never change one channel's item/value shape in a way that breaks GA4 dedup without matching the other.
- Unit tests: `npx vitest run <file>` (env node).

---

## File Structure

Files touched (all paths absolute from repo root `/Users/konradciok/repos/ceramics-drop`):

| Finding | File | Change |
|---|---|---|
| N-4 | `src/lib/marketing/ga4-mp.ts` | add optional `item_variant` to `Ga4Item` |
| N-4 | `src/lib/marketing/conversions.ts` | populate `item_variant` on the ceramic GA4 item |
| N-4 | `src/lib/marketing/conversions.test.ts` | assert ceramic item carries client-equal `item_variant` |
| F-09 | `src/lib/checkout-analytics.ts` | new `pushCheckoutStartedItemsOnce(attemptId, …)` dedup helper |
| F-09 | `src/lib/checkout-analytics.test.ts` | dedup-per-attempt tests |
| F-09 | `src/components/shop/CartView.tsx` | call the once-variant with `attemptId` |
| N-5 | `src/components/shop/ProductTile.tsx` | `priceOfCurrency` + `currency` on `showroom_product_view` / `sold_item_view` |
| N-5 | `src/components/shop/SelectionBar.tsx` | `currency` on `cart_clear` / `cart_cta_click` |
| N-5 / N-10 | `docs/analytics-stack.md` | doc rows (currency param, renamed newsletter event) |
| N-10 | `src/components/layout/FooterNewsletterForm.tsx` | rename event → `newsletter_signup_requested` |
| F-25 | `src/app/api/stripe/webhook/route.ts` | `Sentry.captureMessage` on `sendPurchasedEvent` failure |
| F-25 | `src/app/api/stripe/webhook/route.test.ts` | assert the Sentry call |

The five tasks are independent — implement and commit in any order. Ordered below TDD-first (logic tasks with tests, then plumbing).

---

## Task 1 — N-4: symmetric server GA4 purchase items (`item_variant`)

**Problem.** The client purchase item carries `item_variant` (`Nº <num>` for ceramics, size/frame label for prints) via `toAnalyticsItem` (`src/lib/analytics.ts:97-108`). The server GA4 MP builder already sets `item_variant` for **prints** (`conversions.ts:67-77`) but **omits it for ceramics** (`conversions.ts:79-88`), and the `Ga4Item` type never declared the field (`ga4-mp.ts:1-8`). Both channels share `transaction_id`, so GA4 keeps whichever purchase lands first — item detail is a race. Fix: declare `item_variant` on `Ga4Item` and populate it on the ceramic branch from the same `toAnalyticsItem` value the client uses.

### Steps

- [ ] **1.1 Write the failing test first.** In `src/lib/marketing/conversions.test.ts`, add two imports below the existing `import … from './conversions'` (top of file, the sibling `../products` / `../analytics` paths match `conversions.ts`'s own imports):

  ```ts
  import { registryProductById } from '../products';
  import { toAnalyticsItem } from '../analytics';
  ```

  Then add this test inside the existing `describe('sendPurchaseConversions', …)` block (e.g. right after the `sends Meta (value=total/100) …` test at line 65):

  ```ts
  it('mirrors the client item_variant on the ceramic GA4 item (N-4 symmetry)', async () => {
    const d = deps();
    await sendPurchaseConversions('pi_1', d);
    const ga4Input = d.sendGa4.mock.calls[0][1];
    const ceramicItem = ga4Input.items.find((i: { item_id: string }) => i.item_id === 'k01');
    // Server item_variant must equal what the client builder produces for the same piece.
    const expected = toAnalyticsItem(registryProductById('k01')!);
    expect(ceramicItem.item_variant).toBe(expected.item_variant);
    expect(ceramicItem.item_variant).toMatch(/^Nº \d+$/);
  });
  ```

  Run it — it MUST fail (red), because the ceramic branch does not yet set `item_variant`:

  ```bash
  npx vitest run src/lib/marketing/conversions.test.ts
  ```

  Expected: the new test fails with `expected undefined to be 'Nº <n>'`; all pre-existing tests still pass.

- [ ] **1.2 Declare the field on `Ga4Item`.** In `src/lib/marketing/ga4-mp.ts`, extend the type (lines 1-8) with an optional `item_variant` (the print branch already emits it at runtime; this makes it typed rather than an undeclared excess property):

  ```ts
  export type Ga4Item = {
    item_id: string;
    item_name: string;
    price: number;
    quantity: number;
    item_category: string;
    item_brand: string;
    item_variant?: string;
  };
  ```

- [ ] **1.3 Populate the ceramic branch.** In `src/lib/marketing/conversions.ts`, the ceramic branch of the `ga4Items` map (lines 79-88) already computes `ai = toAnalyticsItem(p)`, which carries `item_variant: `Nº ${product.num}``. Add it to the returned object:

  ```ts
      const p = productById.get(item.product_id);
      const ai = p ? toAnalyticsItem(p) : null;
      return {
        item_id: item.product_id,
        item_name: ai?.item_name ?? item.product_id,
        price: item.unit_price / 100,
        quantity: 1 as const,
        item_category: ai?.item_category ?? '',
        item_brand: ai?.item_brand ?? 'Anna Ciok Ceramics',
        // N-4: mirror the client's item_variant (`Nº <num>`) so browser and server GA4
        // purchase items agree — GA4 keeps whichever hit lands first per transaction_id.
        ...(ai?.item_variant ? { item_variant: ai.item_variant } : {}),
      };
  ```

  (The print branch at lines 67-77 is unchanged — it already sets `item_variant` from `variantLabel(...)`.)

- [ ] **1.4 Go green + typecheck.**

  ```bash
  npx vitest run src/lib/marketing/conversions.test.ts
  npm run typecheck
  ```

  Expected: `conversions.test.ts` all tests pass (including the new one and the pre-existing print test at lines 81-114 that asserts `item_variant: '50×70 cm · frame black'`); `typecheck` exits 0.

- [ ] **1.5 Commit.**

  ```bash
  git add src/lib/marketing/ga4-mp.ts src/lib/marketing/conversions.ts src/lib/marketing/conversions.test.ts
  git commit -m "fix(analytics): add item_variant to server GA4 purchase items (N-4)"
  ```

---

## Task 2 — F-09: dedup `begin_checkout` per checkout attempt

**Problem.** `CartView.tsx:349` fires `begin_checkout` (via `pushCheckoutStartedItems`) on every pay-click that clears the `submitting` guard, **before** the `/api/checkout` fetch. On a recoverable failure that keeps the same `attemptId` — a pure network error (`gotResponse === false`, line 469 keeps the id) or `checkout_in_progress` (409, id kept, cart unchanged) — a retry click emits a **second** `begin_checkout`. Fix: dedup per `attemptId` in sessionStorage, mirroring `pushPaymentFailedOnce`. `attemptId` is CartView state (line 179) that is **regenerated** whenever the cart changes (`cartKey` effect, lines 268-274) or a checkout resolves (`resetAttemptId()` on success line 458, `order_conflict` line 381, hard `!res.ok` line 429) — so keying the dedup on `attemptId` correctly allows a fresh event for a genuinely new attempt while suppressing same-attempt retries.

### Steps

- [ ] **2.1 Write the failing tests first.** In `src/lib/checkout-analytics.test.ts`:
  - add `pushCheckoutStartedItemsOnce,` to the existing `import { … } from './checkout-analytics';` list (lines 3-13);
  - add `import { toAnalyticsItem } from './analytics';` below the `import { registryProductById } from './products';` line (line 2).

  Then add these two tests inside `describe('checkout analytics semantics', …)` (e.g. after the `payment_failed fires once …` test at line 256):

  ```ts
  it('begin_checkout fires once per attempt id and dedupes a same-attempt retry', () => {
    const push = vi.fn();
    const storage = new Map<string, string>();
    const session = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
    };
    const items = [toAnalyticsItem(product('k01'))];

    const first = pushCheckoutStartedItemsOnce('attempt_1', items, {
      shippingCost: 18, shippingMethod: 'kurier', push, storage: session,
    });
    const second = pushCheckoutStartedItemsOnce('attempt_1', items, {
      shippingCost: 18, shippingMethod: 'kurier', push, storage: session,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ event: 'begin_checkout' }));
  });

  it('begin_checkout fires again under a fresh attempt id (cart changed / checkout resolved)', () => {
    const push = vi.fn();
    const storage = new Map<string, string>();
    const session = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
    };
    const items = [toAnalyticsItem(product('k01'))];
    pushCheckoutStartedItemsOnce('attempt_1', items, { shippingCost: 18, shippingMethod: 'kurier', push, storage: session });
    pushCheckoutStartedItemsOnce('attempt_2', items, { shippingCost: 18, shippingMethod: 'kurier', push, storage: session });
    expect(push).toHaveBeenCalledTimes(2);
  });
  ```

  Also add a storage-safety test inside the existing `describe('checkout analytics never breaks the storefront when storage throws', …)` block (which defines `throwingStorage` at line 467):

  ```ts
  it('pushCheckoutStartedItemsOnce still emits when storage throws', () => {
    const push = vi.fn();
    let fired = false;
    expect(() => {
      fired = pushCheckoutStartedItemsOnce('attempt_throw', [toAnalyticsItem(product('k01'))], {
        shippingCost: 18, shippingMethod: 'kurier', push, storage: throwingStorage,
      });
    }).not.toThrow();
    expect(fired).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
  });
  ```

  Run — MUST fail to import/compile (the export does not exist yet):

  ```bash
  npx vitest run src/lib/checkout-analytics.test.ts
  ```

  Expected: failure referencing `pushCheckoutStartedItemsOnce` is not a function / not exported.

- [ ] **2.2 Add the dedup helper.** In `src/lib/checkout-analytics.ts`:
  - add the prefix constant beside the existing ones (lines 32-35):

  ```ts
  const BEGIN_CHECKOUT_DEDUPE_PREFIX = 'acc_begin_checkout_attempt:';
  ```

  - add the helper immediately after `pushCheckoutStartedItems` (ends line 67). It reuses the existing `getDefaultStorage` / `safeGetItem` / `safeSetItem` helpers and delegates the actual push to `pushCheckoutStartedItems`, so payload shape stays identical to today:

  ```ts
  /**
   * begin_checkout fired at most once per checkout attempt. CartView regenerates
   * `attemptId` whenever the cart changes or a checkout resolves (success, order_conflict,
   * hard failure), so a retry after a *recoverable* error (network drop, checkout_in_progress)
   * reuses the same attemptId and must not emit a second begin_checkout. Mirrors
   * pushPaymentFailedOnce. Returns true if it fired, false if already fired for this attempt.
   */
  export function pushCheckoutStartedItemsOnce(
    attemptId: string,
    items: AnalyticsItem[],
    options: CheckoutStartOptions & { storage?: SimpleStorage },
  ): boolean {
    const storage = options.storage ?? getDefaultStorage();
    const key = `${BEGIN_CHECKOUT_DEDUPE_PREFIX}${attemptId}`;
    if (safeGetItem(storage, key) === '1') return false;

    pushCheckoutStartedItems(items, options);
    safeSetItem(storage, key, '1');
    return true;
  }
  ```

  (`AnalyticsItem`, `SimpleStorage`, `CheckoutStartOptions` are all already in scope; `pushCheckoutStartedItems` ignores the extra `storage` prop.)

- [ ] **2.3 Wire CartView to the once-variant.** In `src/components/shop/CartView.tsx`:
  - in the import block (lines 25-29), rename `pushCheckoutStartedItems` → `pushCheckoutStartedItemsOnce`:

  ```ts
  import {
    forgetRememberedCheckout,
    pushCheckoutStartedItemsOnce,
    rememberCheckoutForReturn,
  } from '@/lib/checkout-analytics';
  ```

  - at the fire site (line 349) pass `attemptId` (already in scope, state line 179) as the first arg:

  ```ts
      pushCheckoutStartedItemsOnce(attemptId, checkoutItems, {
        shippingCost: shipCost,
        shippingMethod: ship,
        userData: em ? { em } : undefined,
        currency: analyticsCurrency,
      });
  ```

  (`pushCheckoutStartedItems` had no other call site in CartView — grep confirms line 27 import + line 349 only.)

- [ ] **2.4 Go green + typecheck.**

  ```bash
  npx vitest run src/lib/checkout-analytics.test.ts
  npm run typecheck
  ```

  Expected: all `checkout-analytics.test.ts` tests pass (new + pre-existing); `typecheck` exits 0 (CartView's renamed import resolves).

- [ ] **2.5 Commit.**

  ```bash
  git add src/lib/checkout-analytics.ts src/lib/checkout-analytics.test.ts src/components/shop/CartView.tsx
  git commit -m "fix(analytics): dedup begin_checkout per checkout attempt (F-09)"
  ```

---

## Task 3 — F-25: Sentry alert on `cart.purchased` (abandoned-checkout cancel) failure

**Problem.** `src/app/api/stripe/webhook/route.ts:298-304` fires `sendPurchasedEvent(...)` (the Resend `cart.purchased` event that cancels the abandoned-checkout recovery automation) inside a best-effort try/catch that swallows failure with `console.error` only (line 302). A silent failure means a buyer who just paid can still receive an abandoned-cart email. Fix: add `Sentry.captureMessage(...)` in the catch, matching the `stripe_webhook_*` named-condition pattern already used throughout this file. `Sentry` is already imported (line 2).

### Steps

- [ ] **3.1 Write the failing test first.** In `src/app/api/stripe/webhook/route.test.ts`, add this test inside the existing `describe('webhook email idempotency on retry (F1)', …)` block (right after the `fresh sale (normal path) …` test at line 1117 — it inherits that block's `unclaimedOrderRow`, `makeSucceededSupabase`, `succeededEventRequest`, `supabaseImpl`, and `beforeEach`; `sendPurchasedEvent` is the `vi.fn()` mock at line 41, `Sentry.captureMessage` the mock at line 34):

  ```ts
  it('captures a Sentry message when the cart.purchased (abandoned-checkout cancel) send fails', async () => {
    vi.mocked(sendPurchasedEvent).mockRejectedValueOnce(new Error('resend down'));
    vi.mocked(Sentry.captureMessage).mockClear();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = makeSucceededSupabase({
      casUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      shipmentLookup: { data: { id: 'o1', status: 'paid' }, error: null },
      soldCount: { count: 1, error: null },
      ceramicCount: { count: 1, error: null },
      variantRows: { data: [], error: null },
      emailOrderSelect: { data: unclaimedOrderRow, error: null },
      studioClaim: { data: [{ id: 'o1' }], error: null },
      confirmClaim: { data: [{ id: 'o1' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(succeededEventRequest());

    expect(res.status).toBe(200); // best-effort: the failure must not fail the webhook
    expect(sendPurchasedEvent).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'stripe_webhook_purchased_event_failed',
      expect.objectContaining({ level: 'error', extra: expect.objectContaining({ order_id: 'o1' }) }),
    );
    consoleErrorSpy.mockRestore();
  });
  ```

  (`mockRejectedValueOnce` is a one-shot consumed by this test's single `sendPurchasedEvent` call, so it can't leak into sibling tests that rely on the default resolve.)

  Run — MUST fail (red), because the route emits no `captureMessage` there yet:

  ```bash
  npx vitest run src/app/api/stripe/webhook/route.test.ts
  ```

  Expected: the new test fails on the `Sentry.captureMessage` expectation; all other webhook tests still pass.

- [ ] **3.2 Add the Sentry call.** In `src/app/api/stripe/webhook/route.ts`, extend the catch at lines 301-303:

  ```ts
              } catch (err) {
                console.error('sendPurchasedEvent failed for', orderId, err);
                // A failed cart.purchased leaves the abandoned-checkout automation armed,
                // so a buyer who just paid can still get a recovery email. Best-effort
                // (route still 200s) — surface it like the other webhook conditions.
                Sentry.captureMessage('stripe_webhook_purchased_event_failed', {
                  level: 'error',
                  extra: { order_id: orderId, error: err instanceof Error ? err.message : String(err) },
                });
              }
  ```

- [ ] **3.3 Go green + typecheck.**

  ```bash
  npx vitest run src/app/api/stripe/webhook/route.test.ts
  npm run typecheck
  ```

  Expected: all `route.test.ts` tests pass (new + pre-existing, incl. the `fresh sale` test at 1117 and the retry test at 1068 that assert `sendPurchasedEvent` call counts); `typecheck` exits 0.

- [ ] **3.4 Commit.**

  ```bash
  git add src/app/api/stripe/webhook/route.ts src/app/api/stripe/webhook/route.test.ts
  git commit -m "fix(webhook): Sentry alert on cart.purchased send failure (F-25)"
  ```

---

## Task 4 — N-5: currency on demand-signal events

**Problem.** Four demand-signal `site_engagement` events omit a proper display-currency amount + `currency` label — the same class of bug the #203 fix (commit `f439967`) closed for `remove_from_cart`, whose siblings were missed:
- `showroom_product_view` and `sold_item_view` (`ProductTile.tsx:69,85`) send `price` from `toAnalyticsItem(product)` with **no** `priceOverride` → raw base `product.price` (PLN) regardless of the visitor's currency, and no `currency` field.
- `cart_clear` and `cart_cta_click` (`SelectionBar.tsx:38,53`) send `value`/`total` already in display currency but with **no** `currency` field.

Fix: pass `priceOfCurrency(product, currency)` and add a `currency` sibling. `priceOfCurrency`, `useCurrency()`, and `currencyFormatter().code` are already in scope in both files. **No unit test:** the repo's Vitest is `environment: node` with `include: ['src/**/*.test.ts']` — there is **no** jsdom / Testing-Library infra, `buildEngagementEvent` accepts an untyped `Record<string, unknown>`, and these are one-field plumbing changes with no branch/loop logic. Verified by `typecheck` + `lint` + `build` (matching the #203 fix, which shipped the identical `remove_from_cart` change with no unit test). `ponytail:` deliberately no new test framework for a data-field addition — add a component-test harness only if broader component coverage is ever wanted.

### Steps

- [ ] **4.1 ProductTile — `showroom_product_view`.** In `src/components/shop/ProductTile.tsx`, the `if (showroom)` branch (lines 68-76): thread the display price through `toAnalyticsItem` and add `currency`:

  ```ts
          const item = toAnalyticsItem(product, { priceOverride: priceOfCurrency(product, currency) });
          pushDataLayer(
            buildEngagementEvent('showroom_product_view', {
              item_id: item.item_id,
              item_name: item.item_name,
              item_category: item.item_category,
              price: item.price,
              currency: analyticsCurrency,
            }),
          );
  ```

- [ ] **4.2 ProductTile — `sold_item_view`.** Same file, the `if (product.sold)` branch (lines 84-92):

  ```ts
          const item = toAnalyticsItem(product, { priceOverride: priceOfCurrency(product, currency) });
          pushDataLayer(
            buildEngagementEvent('sold_item_view', {
              item_id: item.item_id,
              item_name: item.item_name,
              item_category: item.item_category,
              price: item.price,
              currency: analyticsCurrency,
            }),
          );
  ```

  (`priceOfCurrency` imported line 9; `currency = useCurrency()` line 36; `analyticsCurrency` = `currencyFormatter(currency).code` line 37.)

- [ ] **4.3 SelectionBar — expose the currency code.** In `src/components/shop/SelectionBar.tsx`, line 17, destructure `code`:

  ```ts
    const { fmt, code: analyticsCurrency } = currencyFormatter(currency);
  ```

- [ ] **4.4 SelectionBar — `cart_clear` + `cart_cta_click`.** Same file — add `currency: analyticsCurrency` to both engagement payloads (`total` at line 23 is already computed via `priceOfCurrency`, so the money is already in display currency; only the label is missing):

  ```ts
                pushDataLayer(
                  buildEngagementEvent('cart_clear', {
                    item_ids: products.map((product) => product.id),
                    value: total,
                    currency: analyticsCurrency,
                  }),
                );
  ```

  ```ts
                pushDataLayer(
                  buildEngagementEvent('cart_cta_click', {
                    location: 'selection_bar',
                    num_items: n,
                    value: total,
                    currency: analyticsCurrency,
                  }),
                );
  ```

- [ ] **4.5 Doc — keep the documented row accurate.** In `docs/analytics-stack.md`, line 50, add `currency` to the `sold_item_view` params column (the only one of these four already in the table; the other three are part of the separate undocumented-types finding F-20, out of scope here):

  ```
  | `sold_item_view` | buyer clicks an already-sold tile (demand signal for drops) | `item_id`, `item_name`, `item_category`, `price`, `currency` |
  ```

- [ ] **4.6 Verify.**

  ```bash
  npm run typecheck
  npm run lint
  ```

  Expected: both exit 0. (Optional manual check: on a `/sklep` grid in an EUR session, click a sold tile and inspect `window.dataLayer` — the `site_engagement` `sold_item_view` entry now carries `currency: 'EUR'` and a EUR `price`; the `acc_analytics_debug` mirror is active on localhost per `analytics.ts:471-477`.)

- [ ] **4.7 Commit.**

  ```bash
  git add src/components/shop/ProductTile.tsx src/components/shop/SelectionBar.tsx docs/analytics-stack.md
  git commit -m "fix(analytics): currency on demand-signal engagement events (N-5)"
  ```

---

## Task 5 — N-10: honest newsletter counting

**Problem.** `newsletter_signup` fires on the POST 200 in `src/components/layout/FooterNewsletterForm.tsx:40` — that is **step 1** of the double opt-in (a confirmation email was sent), not a confirmed subscription. The confirmation GET (`src/app/api/newsletter/confirm/route.ts`) creates the Resend contact and fires nothing, so the event overcounts subscribers vs actual contacts. **Smallest correct fix (recommended):** rename the client event to `newsletter_signup_requested` so its name matches what actually happened. This is a one-token change in the only code reference (grep confirms `FooterNewsletterForm.tsx:40` is the sole occurrence in `src/`). GTM forwards the generic `site_engagement` event by name (regex on `_event`) and `engagement_type` is a free-form param, so **no GTM/GA4 config change** is needed — the renamed value flows through unchanged and historical `newsletter_signup` rows keep their old value under the same `engagement_type` dimension.

**Deliberately NOT built (documented non-goal):** a separate confirmed-subscription event on the `/newsletter?status=confirmed` landing page. The authoritative confirmed-contact count already lives in the Resend dashboard; adding a second client event + landing-page island is over-build for this finding. `ponytail:` rename is the whole fix.

### Steps

- [ ] **5.1 Rename the event.** In `src/components/layout/FooterNewsletterForm.tsx`, line 40:

  ```ts
        pushDataLayer(buildEngagementEvent('newsletter_signup_requested'));
  ```

  The component docstring (lines 13-20) already states the "done" copy "promises an email, not a subscription", so the rename is consistent with existing intent — no docstring change required.

- [ ] **5.2 Doc — record the honest name.** In `docs/analytics-stack.md`, add a row to the `engagement_type` table (after the `sold_item_view` row, line 50):

  ```
  | `newsletter_signup_requested` | footer newsletter POST accepted — step 1 of the double opt-in (a confirmation email was sent; NOT a confirmed subscription — the confirmed-contact count lives in Resend) | — |
  ```

- [ ] **5.3 Verify.**

  ```bash
  npm run typecheck
  npm run lint
  grep -rn "newsletter_signup'" src   # expect: no matches (only the renamed value remains)
  ```

  Expected: `typecheck`/`lint` exit 0; the grep returns nothing (the old exact-string literal is gone).

- [ ] **5.4 Commit.**

  ```bash
  git add src/components/layout/FooterNewsletterForm.tsx docs/analytics-stack.md
  git commit -m "fix(analytics): rename newsletter event to newsletter_signup_requested (N-10)"
  ```

---

## Final verification (after all five tasks)

- [ ] Full unit suite + static gates:

  ```bash
  npm run test
  npm run typecheck
  npm run lint
  ```

  Expected: `npm run test` all files pass (the three changed test files — `conversions.test.ts`, `checkout-analytics.test.ts`, `webhook/route.test.ts` — plus every unchanged suite); `typecheck` and `lint` exit 0.

- [ ] Sanity-scan the invariants:
  - `git grep -n "purchase-\${" src/lib` and `transaction_id` usage unchanged — the deterministic purchase dedup key is untouched (N-4 only added an item field; value/`transaction_id` unchanged).
  - `git grep -n "gtag(\|fbq(" src` returns only the consent snippet / GTM-internal pushes (no new direct calls).
