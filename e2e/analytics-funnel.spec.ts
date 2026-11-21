import { test, expect } from '@playwright/test';
import { resetCart, goToCart, sel } from './helpers/checkout';

// Ceramic funnel. The hermetic server runs with E2E_CERAMIC_SALE_FIXTURE (see
// playwright.config.ts), so pieces are purchasable without a real backend.
test.describe('@ci analytics dataLayer contract', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test('cart funnel emits the expected event sequence', async ({ page }) => {
    // Read the app-event mirror (acc_analytics_debug — pushDataLayer writes it on
    // debug hosts incl. localhost, per analytics.ts) rather than raw dataLayer: it
    // holds ONLY app events, so the sequence and per-event counts are deterministic
    // (dataLayer also carries gtm.js/gtm.load/consent noise).
    const events = () =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem('acc_analytics_debug');
        const buf = raw ? (JSON.parse(raw) as Array<{ event?: string }>) : [];
        return buf.map((e) => e.event ?? '').filter(Boolean);
      });

    await resetCart(page);
    // Each funnel event fires client-side after hydration (mount effects / click
    // handlers), so wait for it before acting. Without this, a cold first request
    // (the first test of a CI run) could click an inert server-rendered button.
    await page.goto('/kubki');
    await expect.poll(events, { message: 'view_item_list on /kubki' }).toContain('view_item_list');
    const tile = page.locator(`${sel.productTile}:not([data-sold="true"]):not([data-showroom="true"])`).first();
    await tile.locator(sel.addToCart).click();
    await expect.poll(events, { message: 'add_to_cart on the tile' }).toContain('add_to_cart');
    await goToCart(page);
    await expect(page.locator(sel.cartLine).first()).toBeVisible();
    // view_cart fires from CartView's effect after the lines render.
    await expect.poll(events, { message: 'view_cart on /koszyk' }).toContain('view_cart');

    // Funnel must fire IN ORDER and exactly once each: /kubki → view_item_list,
    // add-to-cart click → add_to_cart, /koszyk → view_cart. The polls above only
    // establish presence; a duplicate or a missing event makes this filtered
    // slice differ from the exact sequence → fail.
    const funnel = (await events()).filter((e) =>
      ['view_item_list', 'add_to_cart', 'view_cart'].includes(e),
    );
    expect(funnel).toEqual(['view_item_list', 'add_to_cart', 'view_cart']);
  });

  // The `?sale=` token-leak assertion is intentionally NOT duplicated here:
  // Plan 1 shipped the authoritative e2e/analytics-token-leak.spec.ts (URL-strip +
  // no token in any dataLayer push or network request). This spec is the
  // event-sequence smoke only (see the plan's G3a cross-plan note).
});
