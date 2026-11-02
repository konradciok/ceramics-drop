import { test, expect } from '@playwright/test';
import { resetCart, goToCart, sel } from './helpers/checkout';

// Uses a fine-art print, not a ceramic: ceramic purchasability now depends on
// onlineAvailable (the active-drop gate, src/lib/ceramic-sale-state.ts), which
// fails closed without a real backend — the print path has no such gate, so
// it's the reliable way to exercise this funnel hermetically.
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
    // handlers), so wait for it before navigating on. Without this, a cold first
    // request (the first test of a CI run) could unload /sklep before
    // PrintCollectionAnalytics' effect ran, dropping view_item_list.
    await page.goto('/sklep');
    await expect.poll(events, { message: 'view_item_list on /sklep' }).toContain('view_item_list');
    await page.goto('/fine-art-prints/fap005');
    // view_item (PrintViewAnalytics) proves the PDP hydrated, so the option and
    // print-add clicks below can't land on inert server-rendered buttons.
    await expect.poll(events, { message: 'view_item on the print PDP' }).toContain('view_item');
    await page.getByTestId('opt-size-50x70').click();
    await page.getByTestId('print-add').click();
    await expect.poll(events, { message: 'add_to_cart on print-add' }).toContain('add_to_cart');
    await goToCart(page);
    await expect(page.locator(sel.cartLine).first()).toBeVisible();
    // view_cart fires from CartView's effect after the lines render.
    await expect.poll(events, { message: 'view_cart on /koszyk' }).toContain('view_cart');

    // Funnel must fire IN ORDER and exactly once each: /sklep → view_item_list,
    // print-add click → add_to_cart, /koszyk → view_cart. The polls above only
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
