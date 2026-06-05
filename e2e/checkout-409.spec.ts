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
    // Categories verified against src/lib/products.ts CATEGORIES; the helper
    // picks the first unsold tile, so the test is data-driven within each.
    const a = await addFirstUnsoldFromCategory(page, 'kubki');
    const b = await addFirstUnsoldFromCategory(page, 'talerzyki');
    expect(a.category).not.toBe(b.category);

    await goToCart(page);
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

    // cart.soldOut (messages/pl.json): "Niektóre prace zostały właśnie sprzedane…"
    await expect(page.getByText(/właśnie sprzedane/i)).toBeVisible();

    // The sold line is pruned; the other line remains.
    await expect(page.locator(`${sel.cartLine}[data-product-id="${a.id}"]`)).toHaveCount(0);
    await expect(page.locator(`${sel.cartLine}[data-product-id="${b.id}"]`)).toHaveCount(1);
  });
});
