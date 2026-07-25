import { test, expect } from '@playwright/test';
import {
  resetCart,
  addFirstUnsoldFromCategory,
  goToCart,
  selectPaczkomat,
  fillContact,
  mockGeowidget,
  mockLockerSelection,
  sel,
} from './helpers/checkout';

// Failure path: /api/checkout returns 409 (item sold out between add-to-cart and checkout).
// Expected: the app surfaces cart.soldOut copy and prunes the affected line from the cart
// (CartView.handleCheckout — removes each id in the 409 `sold` array).
// @ci-safe — the checkout response is mocked, so no real order is created.
test.describe('@checkout-edge @ci checkout 409', () => {
  test.describe.configure({ mode: 'serial' });

  test('handles 409 by showing sold-out and pruning the cart', async ({ page, context }) => {
    await resetCart(page);
    await mockGeowidget(page, context);
    // One-of-a-kind inventory: any hardcoded category can sell out and break
    // the spec (talerzyki did). Probe the families in order and take the first
    // two that still have unsold stock.
    const candidates = ['kubki', 'talerzyki', 'talerze-srednie', 'miski-falowane', 'wazony', 'duze-michy'];
    const picks = [];
    for (const category of candidates) {
      if (picks.length === 2) break;
      await page.goto(`/${category}`);
      const tile = page.locator('[data-testid="product-tile"]:not([data-sold="true"])').first();
      // Collection pages stream behind a Suspense fallback (loading.tsx), so an
      // instant isVisible() sample right after goto() can miss a grid that is
      // still rendering on a slow CI runner and skip a fully-stocked category.
      // Wait briefly instead; a timeout means the category truly has no unsold tile.
      const visible = await tile.waitFor({ state: 'visible', timeout: 5_000 }).then(
        () => true,
        () => false,
      );
      if (!visible) continue;
      picks.push(await addFirstUnsoldFromCategory(page, category));
    }
    expect(picks.length, 'need two categories with unsold stock').toBe(2);
    const [a, b] = picks;
    expect(a.category).not.toBe(b.category);

    await goToCart(page);
    // Ceramic checkout never offers a country choice — InPost is PL-only; the
    // selector exists solely on the print path (Finding 11 regression guard).
    await expect(page.getByTestId('country-select')).toHaveCount(0);
    await selectPaczkomat(page);
    await fillContact(page);
    await mockLockerSelection(page);

    // Force a 409 for product A — body shape mirrors src/app/api/checkout/route.ts:
    // { error: 'unavailable', sold: [...conflicting ids] }
    await page.route('**/api/checkout', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable', sold: [a.id] }),
      }),
    );

    await page.locator(sel.checkoutButton).click();

    // cart.soldOut (messages/pl.json): "Część prac została już sprzedana…"
    await expect(page.getByText(/została już sprzedana/i)).toBeVisible();

    // The sold line is pruned; the other line remains.
    await expect(page.locator(`${sel.cartLine}[data-product-id="${a.id}"]`)).toHaveCount(0);
    await expect(page.locator(`${sel.cartLine}[data-product-id="${b.id}"]`)).toHaveCount(1);
  });
});
