import { test, expect } from '@playwright/test';
import {
  resetCart,
  addPrintVariant,
  goToCart,
  selectPaczkomat,
  fillContact,
  mockGeowidget,
  mockLockerSelection,
  fillStripeCard,
  sel,
} from './helpers/checkout';

/**
 * @destructive — completes a real Stripe test-mode payment for a PRINT-ONLY order.
 * Critical regression guard for the webhook fulfillment fix: a print order has no
 * piece_state rows, so markPaid must NOT auto-refund it (expected = 0 = fulfilled).
 *
 *   PLAYWRIGHT_BASE_URL=https://anna-ciok.studio npx playwright test --grep @destructive
 */
const SUCCESS_CARD = '4242424242424242';

test.describe('@checkout @destructive print-only purchase', () => {
  test('buys a single fine-art print via paczkomat + card', async ({ page, context, baseURL }) => {
    if (/localhost|127\.0\.0\.1/.test(baseURL ?? '') && process.env.E2E_ALLOW_LOCALHOST !== '1') {
      test.skip(true, `baseURL is ${baseURL}; set E2E_ALLOW_LOCALHOST=1 to run @destructive locally.`);
    }

    await resetCart(page);
    await mockGeowidget(page, context);

    const token = await addPrintVariant(page, 'fap01', { size: 'a3', paper: 'satin', frame: 'oak' });

    await goToCart(page);
    const line = page.locator(`${sel.cartLine}[data-product-id="${token}"]`);
    await expect(line).toBeVisible();

    await selectPaczkomat(page);
    await fillContact(page);
    await mockLockerSelection(page);

    await expect(page.locator(sel.checkoutButton)).toBeEnabled();
    await page.locator(sel.checkoutButton).click();

    await expect(page.locator(sel.paymentSubmit)).toBeVisible({ timeout: 30_000 });
    await fillStripeCard(page, SUCCESS_CARD);
    await page.locator(sel.paymentSubmit).click();

    await page.waitForURL(/\/koszyk\/return\?.*payment_intent/, { timeout: 90_000 });
    await expect(page.locator(sel.checkoutSuccess)).toBeVisible({ timeout: 30_000 });
  });
});
