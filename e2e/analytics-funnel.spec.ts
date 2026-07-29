import { test, expect } from '@playwright/test';
import { resetCart, addFirstUnsoldFromCategory, goToCart, sel } from './helpers/checkout';

test.describe('@ci analytics dataLayer contract', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test('cart funnel emits the expected event sequence', async ({ page }) => {
    await resetCart(page);
    // view_item_list fires on gallery render; add_to_cart on the tile click.
    const picked = await addFirstUnsoldFromCategory(page, 'kubki');
    expect(picked.id, 'a kubki tile must exist').toBeTruthy();
    await goToCart(page); // view_cart fires on cart render
    await expect(page.locator(sel.cartLine).first()).toBeVisible();

    // Read the app-event mirror (acc_analytics_debug — pushDataLayer writes it on
    // debug hosts incl. localhost, per analytics.ts) rather than raw dataLayer: it
    // holds ONLY app events, so the sequence and per-event counts are deterministic
    // (dataLayer also carries gtm.js/gtm.load/consent noise).
    const events = await page.evaluate(() => {
      const raw = sessionStorage.getItem('acc_analytics_debug');
      const buf = raw ? (JSON.parse(raw) as Array<{ event?: string }>) : [];
      return buf.map((e) => e.event ?? '').filter(Boolean);
    });
    // Funnel must fire IN ORDER and exactly once each: /kubki → view_item_list,
    // tile click → add_to_cart, /koszyk → view_cart. A duplicate or a missing
    // event makes this filtered slice differ from the exact sequence → fail.
    const funnel = events.filter((e) => ['view_item_list', 'add_to_cart', 'view_cart'].includes(e));
    expect(funnel).toEqual(['view_item_list', 'add_to_cart', 'view_cart']);
  });

  // The `?sale=` token-leak assertion is intentionally NOT duplicated here:
  // Plan 1 shipped the authoritative e2e/analytics-token-leak.spec.ts (URL-strip +
  // no token in any dataLayer push or network request). This spec is the
  // event-sequence smoke only (see the plan's G3a cross-plan note).
});
