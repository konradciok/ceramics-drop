import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
  CART_KEY,
  resetCart,
  addFirstUnsoldFromCategory,
  goToCart,
  selectPaczkomat,
  fillContact,
  mockGeowidget,
  mockLockerSelection,
  fillStripeCard,
  sel,
  type PickedProduct,
} from './helpers/checkout';
import { SHIPPING_PLN } from '../src/lib/pricing';
import { pln } from '../src/lib/format';

/**
 * Release-gate happy path — docs/e2e-playwright-purchase-flow.md.
 *
 * DESTRUCTIVE: completes a real Stripe test-mode payment. The webhook marks both
 * pieces SOLD in the shared database and creates a real InPost shipment. Run on
 * demand / release-gate only — never on every PR.
 *
 *   PLAYWRIGHT_BASE_URL=https://anna-ciok.studio npx playwright test --grep @destructive
 *
 * Geowidget mode (E2E_GEOWIDGET_MODE):
 *   mock (default) — stub <inpost-geowidget> + dispatch 'onpoint'; deterministic.
 *   real           — drive the third-party map (headed recommended; flaky → env blocker).
 */

const SUCCESS_CARD = '4242424242424242';
const GEOWIDGET_MODE = process.env.E2E_GEOWIDGET_MODE === 'real' ? 'real' : 'mock';
const BUYER_EMAIL = 'e2e+playwright@example.com';

// Mirrors VISIBLE_CATEGORY_ORDER in src/lib/products.ts — all nine families
// are now public, so the stock probe covers the full catalogue.
const ALL_CATEGORIES = [
  'kubki',
  'wazony',
  'wazony-srednie',
  'wazony-duze',
  'talerzyki',
  'talerze-srednie',
  'talerze-duze',
  'duze-michy',
  'miski-falowane',
] as const;

// ── Shared state across the serial pair (preflight → purchase) ──────────────
const stockedCategories: string[] = [];
let productA: PickedProduct | null = null;
let productB: PickedProduct | null = null;
let lockerCode = '';
let returnUrl = '';
let stripeKeyMode: 'test' | 'live' | 'unseen' = 'unseen';
let step = 'not-started';

const evidence = {
  checkoutResponses: [] as Array<{ url: string; status: number; body?: string }>,
  consoleErrors: [] as string[],
  pageErrors: [] as string[],
  inventoryBefore: [] as string[],
  inventoryAfter: [] as string[],
};

function attachEvidence(page: Page) {
  page.on('response', async (response) => {
    if (response.url().includes('/api/checkout')) {
      evidence.checkoutResponses.push({
        url: response.url(),
        status: response.status(),
        body: response.status() >= 400 ? await response.text().catch(() => '') : undefined,
      });
    }
  });
  page.on('pageerror', (err) => evidence.pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') evidence.consoleErrors.push(msg.text());
  });
}

/** Best-effort real-map interaction. Failure here is an environment blocker, not an app bug. */
async function selectLockerViaRealWidget(page: Page): Promise<void> {
  await page.locator('inpost-geowidget').waitFor({ state: 'attached', timeout: 30_000 });
  try {
    // Playwright pierces open shadow DOM with CSS locators.
    const search = page
      .locator('inpost-geowidget input[type="search"], inpost-geowidget input[type="text"]')
      .first();
    await search.waitFor({ state: 'visible', timeout: 30_000 });
    await search.fill('Warszawa centrum');
    await search.press('Enter');
    const point = page.locator('inpost-geowidget [class*="point"], inpost-geowidget li').first();
    await point.click({ timeout: 30_000 });
    const choose = page
      .locator('inpost-geowidget button:has-text("Wybierz"), inpost-geowidget button:has-text("Select")')
      .first();
    if (await choose.isVisible().catch(() => false)) await choose.click();
    await expect(page.locator(sel.selectedLocker)).toBeVisible({ timeout: 30_000 });
  } catch (err) {
    throw new Error(
      `ENVIRONMENT BLOCKER: could not drive the real Geowidget map (${String(err)}). ` +
        'Re-run headed, or use E2E_GEOWIDGET_MODE=mock.',
    );
  }
}

test.describe('@checkout @destructive purchase two categories via paczkomat', () => {
  test.describe.configure({ mode: 'serial' });

  test('preflight: environment and stock', async ({ page, request, baseURL }) => {
    step = 'preflight';

    // Localhost runs hit the same shared Stripe/Supabase backends — opt in explicitly.
    if (/localhost|127\.0\.0\.1/.test(baseURL ?? '') && process.env.E2E_ALLOW_LOCALHOST !== '1') {
      throw new Error(
        `ENVIRONMENT BLOCKER: baseURL is ${baseURL}; set E2E_ALLOW_LOCALHOST=1 to run @destructive locally.`,
      );
    }

    const inventory = await request.get(`/api/inventory?ts=${Date.now()}`);
    expect(inventory.ok(), 'GET /api/inventory must return 200').toBeTruthy();
    const { sold } = (await inventory.json()) as { sold: string[] };
    evidence.inventoryBefore = sold;

    // Fail fast if a live publishable key leaks into the page. NEXT_PUBLIC_* is
    // inlined into JS chunks rather than SSR HTML, so scan a bounded sample of
    // chunks too; record pk_test_ sightings for the report.
    const cartHtml = await (await request.get('/koszyk')).text();
    expect(cartHtml, 'page HTML must not reference a live Stripe key').not.toContain('pk_live_');
    const chunkSrcs = [...cartHtml.matchAll(/src="([^"]*\/_next\/[^"]+\.js)"/g)]
      .map((m) => m[1])
      .slice(0, 15);
    for (const src of chunkSrcs) {
      const js = await (await request.get(src)).text().catch(() => '');
      expect(js, `live Stripe key found in ${src}`).not.toContain('pk_live_');
      if (js.includes('pk_test_')) stripeKeyMode = 'test';
    }

    // Find two distinct categories with unsold stock from the collection pages
    // (data-driven — no hardcoded product IDs).
    for (const category of ALL_CATEGORIES) {
      await page.goto(`/${category}`);
      const unsold = await page
        .locator(`${sel.productTile}:not([data-sold="true"])`)
        .count();
      if (unsold > 0) stockedCategories.push(category);
      if (stockedCategories.length >= 2) break;
    }
    expect(
      stockedCategories.length,
      `need ≥2 categories with unsold stock, found: ${stockedCategories.join(', ') || 'none'}`,
    ).toBeGreaterThanOrEqual(2);
  });

  test('purchase two categories via paczkomat + card', async ({ page, context, request }) => {
    step = 'setup';
    await resetCart(page);
    attachEvidence(page);

    // Hard safety gate: abort ANY Stripe API call carrying a live key. Watching
    // all api.stripe.com traffic (not just /confirm) gives many capture points,
    // so the key-mode check doesn't hinge on one request's payload shape.
    await page.route(/api\.stripe\.com/, (route) => {
      const payload = `${route.request().url()} ${route.request().postData() ?? ''}`;
      if (payload.includes('pk_live_')) {
        stripeKeyMode = 'live';
        return route.abort();
      }
      if (stripeKeyMode !== 'live' && payload.includes('pk_test_')) stripeKeyMode = 'test';
      return route.continue();
    });

    if (GEOWIDGET_MODE === 'mock') await mockGeowidget(page, context);

    step = 'add products';
    const [catA, catB] = stockedCategories;
    productA = await addFirstUnsoldFromCategory(page, catA);
    productB = await addFirstUnsoldFromCategory(page, catB);
    expect(productA.category).not.toBe(productB.category);
    expect(productA.id, 'product A id').toBeTruthy();
    expect(productB.id, 'product B id').toBeTruthy();

    step = 'cart';
    await goToCart(page);
    await expect(page.locator(`${sel.cartLine}[data-product-id="${productA.id}"]`)).toHaveCount(1);
    await expect(page.locator(`${sel.cartLine}[data-product-id="${productB.id}"]`)).toHaveCount(1);

    // Totals — pln() renders "<int> zł"; compare numerically via data-price sums.
    const subtotal = productA.price + productB.price;
    await selectPaczkomat(page);
    await expect(page.locator('.sum-row .v').first()).toHaveText(`${subtotal} zł`);
    await expect(page.locator('.sum-row .v').nth(1)).toHaveText(pln(SHIPPING_PLN.paczkomat));
    await expect(page.locator('.sum-total .v')).toHaveText(pln(subtotal + SHIPPING_PLN.paczkomat));

    step = 'delivery';
    await fillContact(page, BUYER_EMAIL);
    if (GEOWIDGET_MODE === 'mock') {
      await mockLockerSelection(page);
    } else {
      await selectLockerViaRealWidget(page);
    }
    lockerCode =
      (await page.locator(`${sel.selectedLocker} strong`).textContent())?.trim() ?? '';
    expect(lockerCode, 'a locker code must be shown').not.toBe('');
    await expect(page.locator(sel.checkoutButton)).toBeEnabled();

    step = 'checkout';
    await page.locator(sel.checkoutButton).click();
    const checkoutResponse = await page.waitForResponse((r) => r.url().includes('/api/checkout'));
    expect(checkoutResponse.status(), 'POST /api/checkout must be 2xx').toBeLessThan(300);
    await expect(page.locator(sel.paymentSubmit)).toBeVisible({ timeout: 30_000 });

    step = 'payment';
    await fillStripeCard(page, SUCCESS_CARD);
    await page.locator(sel.paymentSubmit).click();
    // Order matters: fill → submit → redirect → assert (brief §Stripe test card).
    await page.waitForURL(/\/koszyk\/return\?.*payment_intent/, { timeout: 90_000 });
    returnUrl = page.url();
    // Hard-fail on a live key (the route above also aborted it); soft-flag if no
    // key was captured at all so a Stripe payload change doesn't sink a green run.
    expect(stripeKeyMode, 'a pk_live_ key must never be used').not.toBe('live');
    expect.soft(stripeKeyMode, 'expected to observe a pk_test_ key').toBe('test');

    step = 'success page';
    await expect(page.locator(sel.checkoutSuccess)).toBeVisible({ timeout: 30_000 });

    // Cart cleared — Zustand persist leaves { state: { ids: [] } } (or no key).
    const idsAfter = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      try {
        return (JSON.parse(raw).state?.ids ?? []) as string[];
      } catch {
        return ['<unparseable>'];
      }
    }, CART_KEY);
    expect(idsAfter, 'cart must be empty after success').toEqual([]);

    step = 'inventory sold';
    // Webhook-driven; poll with cache-busting (route sets max-age=30).
    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/inventory?ts=${Date.now()}`);
          const { sold } = (await r.json()) as { sold: string[] };
          evidence.inventoryAfter = sold;
          return [productA!.id, productB!.id].every((id) => sold.includes(String(id)));
        },
        { timeout: 60_000, intervals: [3_000] },
      )
      .toBe(true);

    step = 'done';
  });

  test.afterAll(async ({}, testInfo) => {
    const passed = step === 'done';
    const report = `# E2E findings — purchase two categories via paczkomat

1. **Mode** — ${GEOWIDGET_MODE === 'real' ? 'release-gate (real Geowidget)' : 'release-gate (mocked Geowidget seam)'}; baseURL: ${testInfo.project.use.baseURL ?? 'n/a'}; headed: ${testInfo.project.use.headless === false ? 'yes' : 'no'}
2. **Products** — A: ${productA ? `${productA.id} (${productA.category}, ${productA.price} zł)` : 'n/a'}; B: ${productB ? `${productB.id} (${productB.category}, ${productB.price} zł)` : 'n/a'}; distinct categories: ${productA && productB ? String(productA.category !== productB.category) : 'n/a'}
3. **Delivery** — locker: ${lockerCode || 'n/a'}; contact email: ${BUYER_EMAIL}
4. **Payment** — card: ${SUCCESS_CARD} (Stripe test); key mode seen at confirm: ${stripeKeyMode}; return URL: ${returnUrl || 'never reached'}
5. **Automated checks** — UI path, /api/checkout 2xx, return-page success, cart cleared, totals (subtotal + ${pln(SHIPPING_PLN.paczkomat)} shipping), inventory sold-polling — ${passed ? 'ALL PASS' : `FAILED at step: ${step}`}
6. **Manual verification (NOT asserted by Playwright)** — Stripe Dashboard webhook payment_intent.succeeded → 200; Cloudflare Worker logs; InPost shipment/label email${GEOWIDGET_MODE === 'real' ? '; real Geowidget pick confirmed in headed run' : ''}
7. **Network evidence** — /api/checkout: ${JSON.stringify(evidence.checkoutResponses)}; inventory before: ${evidence.inventoryBefore.length} sold; after: ${evidence.inventoryAfter.length} sold; console errors: ${evidence.consoleErrors.length}; page errors: ${evidence.pageErrors.length}
8. **Result** — ${passed ? 'PASS' : `FAIL (step: ${step})`}
9. **Artifacts** — ${testInfo.outputDir}
10. **Flakes & recommendations** — totals use .sum-row/.sum-total CSS (selector debt); real-widget mode is best-effort and headed-only; inventory poll depends on webhook latency.
`;
    fs.writeFileSync(path.join(__dirname, 'REPORT.md'), report);
    await testInfo.attach('findings-report', { body: report, contentType: 'text/markdown' });
  });
});
