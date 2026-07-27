# Analytics Test-Coverage Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three residual analytics test-coverage gaps from the audit's F-19 finding that aren't already fixed as a side effect of other plans: 5 of `analytics.ts`'s 11 event builders have zero unit tests, `setConsent()`'s `gtag(...)` call is untested (only the cookie write is, via e2e), and no e2e spec ever asserts on `window.dataLayer` despite the app already exposing a QA hook (`acc_analytics_debug`) for exactly that.

**Architecture:** Pure additions — new `it()` cases in existing test files for the builder functions and `setConsent`, plus one new minimal Playwright spec (and one new e2e helper) reading the existing debug hook. No production code changes except where noted.

**Tech Stack:** TypeScript, Vitest, Playwright.

## Global Constraints

- Source audit: `docs/audits/event-system-audit.md`, finding F-19 (Low) — **residual items only**. The checkout-route `orders.marketing` assertions and the Resend webhook route test (also part of F-19) are covered by the `2026-07-26-consent-pii-hygiene.md` and `2026-07-26-resend-email-tracking.md` plans respectively — do not duplicate them here.
- Test runners: Vitest (`npx vitest run <path>`) for unit tests, Playwright (`npm run test:e2e`, which runs `playwright test --grep @ci`) for the e2e spec. Per `AGENTS.md`'s "Playwright stale .next trap": if the e2e run doesn't seem to reflect app changes, `rm -rf .next` first — the `webServer` command only rebuilds when `.next` is missing.
- **Explicitly out of scope:** `vitest environment: 'node'` (no DOM, no component mounts) is a real gap (Strict-Mode double-invoke guards are only tested "functionally," not via real mount/unmount) but switching to `jsdom`/`happy-dom` + adding `@testing-library/react` is a much larger, config-level change than "add missing tests" — not part of this plan. `buildViewCartEvent` (one of the 6 originally-untested builders) has zero production callers today (`CartView.tsx` calls the `*FromItems` sibling instead) — flagged in Self-Review, not tested here; testing genuinely dead code has low value and whether to delete it instead is a separate decision outside this plan's scope.
- Commit after each task.

---

### Task 1: Unit-test the 5 live, currently-untested event builders

**Files:**
- Modify: `src/lib/analytics.test.ts`

**Interfaces:**
- Consumes: `buildPrintAddToCartEvent`, `buildRemoveFromCartEvent`, `buildViewItemEvent`, `buildViewItemListEvent`, `buildSelectItemEvent` (all already exported from `src/lib/analytics.ts` — no production code changes in this task), plus the file's existing `product(id)` fixture helper and `toAnalyticsItem` import.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

In `src/lib/analytics.test.ts`, add `buildPrintAddToCartEvent`, `buildRemoveFromCartEvent`, `buildSelectItemEvent`, `buildViewItemEvent`, and `buildViewItemListEvent` to the multi-line import from `./analytics` at the top of the file (it starts with `ANALYTICS_CURRENCY, buildAddToCartEvent, buildBeginCheckoutEvent, ...` — add whichever of these five aren't already there; if the `2026-07-26-client-funnel-analytics-gaps.md` plan landed first, `buildViewItemEvent`/`buildViewItemListEvent` may already be imported for their print-specific siblings, but the plain (ceramic) versions used below are separate names and still need adding).

Add a new describe block:

```ts
describe('untested event builders (F-19)', () => {
  it('builds add_to_cart for a print variant with GA4 ecommerce data and Meta standard-event mapping', () => {
    const event = buildPrintAddToCartEvent(
      { id: 'fap01', num: '01', variantLabel: 'A4 · unframed', price: 250 },
      { eventId: 'evt-atc-fap01' },
    );

    expect(event).toMatchObject({
      event: 'add_to_cart',
      event_id: 'evt-atc-fap01',
      ecommerce: {
        currency: ANALYTICS_CURRENCY,
        value: 250,
        items: [
          {
            item_id: 'fap01',
            item_name: 'Print Nº 01',
            item_category: 'fine-art-prints',
            item_variant: 'A4 · unframed',
            price: 250,
            quantity: 1,
          },
        ],
      },
      meta: { event_name: 'AddToCart', content_ids: ['fap01'], event_id: 'evt-atc-fap01' },
    });
  });

  it('builds remove_from_cart with GA4 ecommerce data and no Meta payload', () => {
    const event = buildRemoveFromCartEvent(product('k01'), { eventId: 'evt-rfc-k01' });

    expect(event).toMatchObject({
      event: 'remove_from_cart',
      event_id: 'evt-rfc-k01',
      ecommerce: { currency: ANALYTICS_CURRENCY, value: 95, items: [toAnalyticsItem(product('k01'))] },
    });
    expect(event.meta).toBeUndefined();
  });

  it('builds view_item with GA4 ecommerce data and Meta ViewContent mapping', () => {
    const event = buildViewItemEvent(product('k01'), {
      eventId: 'evt-vi-k01',
      itemListId: 'kubki',
      itemListName: 'Kubki',
    });

    expect(event).toMatchObject({
      event: 'view_item',
      event_id: 'evt-vi-k01',
      ecommerce: {
        currency: ANALYTICS_CURRENCY,
        value: 95,
        items: [toAnalyticsItem(product('k01'), { itemListId: 'kubki', itemListName: 'Kubki' })],
      },
      meta: { event_name: 'ViewContent', content_ids: ['k01'], event_id: 'evt-vi-k01' },
    });
  });

  it('builds view_item_list for a set of products with positional index', () => {
    const event = buildViewItemListEvent([product('k01'), product('v01')], {
      itemListId: 'kubki',
      itemListName: 'Kubki',
      eventId: 'evt-vil-kubki',
    });

    expect(event).toMatchObject({
      event: 'view_item_list',
      event_id: 'evt-vil-kubki',
      ecommerce: {
        currency: ANALYTICS_CURRENCY,
        items: [
          toAnalyticsItem(product('k01'), { index: 0, itemListId: 'kubki', itemListName: 'Kubki' }),
          toAnalyticsItem(product('v01'), { index: 1, itemListId: 'kubki', itemListName: 'Kubki' }),
        ],
      },
    });
  });

  it('builds select_item with GA4 ecommerce data and no Meta payload', () => {
    const event = buildSelectItemEvent(product('k01'), {
      index: 2,
      itemListId: 'kubki',
      itemListName: 'Kubki',
      eventId: 'evt-si-k01',
    });

    expect(event).toMatchObject({
      event: 'select_item',
      event_id: 'evt-si-k01',
      ecommerce: {
        currency: ANALYTICS_CURRENCY,
        items: [toAnalyticsItem(product('k01'), { index: 2, itemListId: 'kubki', itemListName: 'Kubki' })],
      },
    });
    expect(event.meta).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/analytics.test.ts -t "untested event builders"`
Expected: FAIL — the new `it()` blocks reference real, existing functions, so this actually fails only if the import or a fixture is wrong. If it fails on an import error, fix the import; if it fails on an assertion mismatch, adjust the expected values to match the real output (these functions are unchanged production code — this step is a sanity check that new coverage is correct, not a red step in the strict sense, since no implementation changes).

- [ ] **Step 3: Run the full file to verify everything passes**

Run: `npx vitest run src/lib/analytics.test.ts`
Expected: PASS — all cases, including every pre-existing test.

- [ ] **Step 4: Commit**

```bash
git add src/lib/analytics.test.ts
git commit -m "test(analytics): cover the 5 previously-untested live event builders"
```

---

### Task 2: Unit-test `setConsent()`'s `gtag` call

**Files:**
- Modify: `src/components/consent/consent-mode.test.ts`

**Interfaces:**
- Consumes: `setConsent` (already exported from `src/components/consent/consent-mode.ts` — no production code changes in this task). `vitest`'s `environment: 'node'` has no `window`/`document` globals, so this test stubs them directly with `vi.stubGlobal` rather than switching the test environment.

- [ ] **Step 1: Write the failing tests**

Extend the existing import in `src/components/consent/consent-mode.test.ts`:

Replace:

```ts
import { describe, it, expect } from 'vitest';
import { defaultConsentSnippet, COOKIE_NAME, readConsent } from './consent-mode';
```

with:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultConsentSnippet, COOKIE_NAME, readConsent, setConsent } from './consent-mode';
```

Add a new describe block:

```ts
describe('setConsent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls gtag consent update with the granted state for all four signals, and persists the cookie', () => {
    const gtagMock = vi.fn();
    let cookieValue = '';
    vi.stubGlobal('window', { gtag: gtagMock });
    vi.stubGlobal('document', {
      get cookie() {
        return cookieValue;
      },
      set cookie(v: string) {
        cookieValue = v;
      },
    });

    setConsent('granted');

    expect(gtagMock).toHaveBeenCalledWith('consent', 'update', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted',
    });
    expect(cookieValue).toContain(`${COOKIE_NAME}=granted`);
  });

  it('calls gtag consent update with the denied state, and never throws when gtag is not yet defined', () => {
    let cookieValue = '';
    vi.stubGlobal('window', {}); // gtag not injected yet
    vi.stubGlobal('document', {
      get cookie() {
        return cookieValue;
      },
      set cookie(v: string) {
        cookieValue = v;
      },
    });

    expect(() => setConsent('denied')).not.toThrow();
    expect(cookieValue).toContain(`${COOKIE_NAME}=denied`);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/consent/consent-mode.test.ts -t "setConsent"`
Expected: FAIL only if `window`/`document` aren't correctly stubbed before `setConsent` runs (e.g. `ReferenceError: document is not defined`) — if so, double-check the `vi.stubGlobal` calls precede the `setConsent(...)` call within each `it()`. Once stubbed correctly, this passes immediately since `setConsent`'s implementation is unchanged, existing code — same sanity-check nature as Task 1's Step 2.

- [ ] **Step 3: Run the full file to verify everything passes**

Run: `npx vitest run src/components/consent/consent-mode.test.ts`
Expected: PASS — all cases, including the pre-existing `defaultConsentSnippet`/`readConsent` suites.

- [ ] **Step 4: Commit**

```bash
git add src/components/consent/consent-mode.test.ts
git commit -m "test(consent): cover setConsent's gtag update call"
```

---

### Task 3: E2E smoke test asserting on the real `dataLayer` via the `acc_analytics_debug` QA hook

**Files:**
- Modify: `e2e/helpers/checkout.ts`
- Create: `e2e/analytics-smoke.spec.ts`

**Interfaces:**
- Produces: `readAnalyticsDebug(page: Page): Promise<{ events: unknown[]; attr: string }>` in `e2e/helpers/checkout.ts`, reading the exact QA hook implemented in `src/lib/analytics.ts:435-461` (`sessionStorage['acc_analytics_debug']` — a JSON array of `{event, engagement_type, ecommerce, meta}` summaries capped at 50 — and `document.documentElement.dataset.accAnalyticsDebug` — a pipe-joined `event:engagement_type` string capped at the last 20).
- Consumes: `resetCart`, `addFirstUnsoldFromCategory`, `goToCart` (existing helpers in the same file).

- [ ] **Step 1: Add the `readAnalyticsDebug` helper**

In `e2e/helpers/checkout.ts`, add after `goToCart`:

```ts
/** Reads the acc_analytics_debug QA hook (src/lib/analytics.ts) — never asserts on real GTM/GA4. */
export async function readAnalyticsDebug(page: Page): Promise<{ events: unknown[]; attr: string }> {
  return page.evaluate(() => ({
    events: JSON.parse(sessionStorage.getItem('acc_analytics_debug') ?? '[]'),
    attr: document.documentElement.dataset.accAnalyticsDebug ?? '',
  }));
}
```

- [ ] **Step 2: Create the smoke spec**

```ts
// e2e/analytics-smoke.spec.ts
import { test, expect } from '@playwright/test';
import { resetCart, addFirstUnsoldFromCategory, goToCart, readAnalyticsDebug } from './helpers/checkout';

/**
 * Smoke-tests that the dataLayer/GA4 event pipeline actually fires in a real
 * browser, using the acc_analytics_debug QA hook (src/lib/analytics.ts)
 * rather than asserting on GTM/GA4 directly — no real events are sent.
 * @ci-safe — cart state only; /api/checkout is never called.
 */
test.describe('analytics dataLayer smoke @ci', () => {
  test('view_item_list, add_to_cart, and view_cart appear in the analytics debug trail', async ({ page }) => {
    await resetCart(page);
    await addFirstUnsoldFromCategory(page, 'kubki');

    let debug = await readAnalyticsDebug(page);
    expect(debug.attr).toContain('view_item_list');
    expect(debug.attr).toContain('add_to_cart');

    await goToCart(page);
    debug = await readAnalyticsDebug(page);
    expect(debug.attr).toContain('view_cart');
  });
});
```

- [ ] **Step 3: Run the spec to verify it passes**

Run: `rm -rf .next && npx playwright test e2e/analytics-smoke.spec.ts` (the `rm -rf .next` avoids the documented stale-build trap — `webServer` only rebuilds when `.next` is missing).
Expected: PASS. If it fails because `debug.attr` is empty, confirm `isDebugHost()` in `src/lib/analytics.ts` is returning `true` for `http://localhost:3000` (it should — hostname `localhost` alone satisfies the check regardless of `NODE_ENV`).

- [ ] **Step 4: Run the full `@ci` suite to confirm no regressions**

Run: `npm run test:e2e`
Expected: PASS — all specs, including the new one.

- [ ] **Step 5: Commit**

```bash
git add e2e/helpers/checkout.ts e2e/analytics-smoke.spec.ts
git commit -m "test(e2e): smoke-test the dataLayer pipeline via the acc_analytics_debug QA hook"
```

---

## Self-Review Notes

- **Coverage:** F-19's "6 of 11 event builders untested" → Task 1 covers 5 of them (the live ones). `buildViewCartEvent` (the 6th) is deliberately **not** tested here — grep confirms zero production callers (`CartView.tsx` uses the `buildViewCartEventFromItems` sibling instead); flagging this for the user rather than either testing genuinely dead code or unilaterally deleting a function outside this plan's stated scope. F-19's "`setConsent()` and the denial path are untested at the gtag level" → Task 2. F-19's "e2e never asserts on `window.dataLayer`, despite `acc_analytics_debug`/`data-acc-analytics-debug` existing" → Task 3.
- **Placeholder scan:** no TBD/TODO; every step shows exact code/commands.
- **No overlap with sibling plans:** confirmed against `2026-07-26-consent-pii-hygiene.md` (checkout-route marketing assertions) and `2026-07-26-resend-email-tracking.md` (Resend webhook route test) — neither task here touches those files.
- **Out of scope (explicitly, not silently dropped):** `vitest environment: 'node'` → `jsdom`/`happy-dom` migration. This is flagged in Global Constraints, not attempted — it's a build-config-level change (new dependency, `include` glob change, potential fallout across every existing `.test.ts` file) far larger than "add missing tests," and the research behind this plan found no evidence it's blocking anything today beyond the two items this plan already closes at the right layer (sessionStorage-guard testing, which is how `checkout-analytics.ts`'s Strict-Mode-adjacent dedup is already tested).
