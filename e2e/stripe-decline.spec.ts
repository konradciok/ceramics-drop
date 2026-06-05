import { test, expect } from '@playwright/test';
import {
  resetCart,
  addFirstUnsoldFromCategory,
  goToCart,
  selectPaczkomat,
  fillContact,
  mockGeowidget,
  mockLockerSelection,
  fillStripeCard,
  sel,
} from './helpers/checkout';

// Failure path: Stripe decline card. Tagged @destructive (config excludes it unless
// E2E_DESTRUCTIVE=1): even a declined card hits the real /api/checkout, which
// reserves the pieces for 15 minutes — running this casually locks shared stock.
// Expected: a payment error is shown (CheckoutForm renders error.message — Stripe's
// PL copy matches /odrzucon/) and the cart is NOT cleared (buyer can retry; the cart
// only clears on /koszyk/return with a succeeded payment intent).
test.describe('@checkout-edge @destructive stripe decline', () => {
  test.describe.configure({ mode: 'serial' });

  const DECLINE_CARD = '4000000000000002';

  test('shows an error and keeps the cart on a declined card', async ({ page, context }) => {
    await resetCart(page);
    await mockGeowidget(page, context);
    const a = await addFirstUnsoldFromCategory(page, 'kubki');
    const b = await addFirstUnsoldFromCategory(page, 'talerzyki');
    expect(a.category).not.toBe(b.category);

    await goToCart(page);
    await selectPaczkomat(page);
    await fillContact(page);
    await mockLockerSelection(page);

    await page.locator(sel.checkoutButton).click();
    // Real /api/checkout: 200 with { client_secret } → Payment Element mounts.
    await page.waitForResponse((r) => r.url().includes('/api/checkout') && r.ok());
    await expect(page.locator(sel.paymentSubmit)).toBeVisible();

    await fillStripeCard(page, DECLINE_CARD);
    await page.locator(sel.paymentSubmit).click();

    // Error surfaced; we never reach the success return page.
    await expect(page.getByText(/odrzucon|declined|nie powiod|błąd płatności/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page).not.toHaveURL(/\/koszyk\/return/);

    // Cart preserved.
    await expect(page.locator(sel.cartLine)).toHaveCount(2);
  });
});
