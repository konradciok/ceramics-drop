import { test, expect } from '@playwright/test';
import {
  resetCart,
  addFirstUnsoldFromCategory,
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
 * @destructive — real Stripe test-mode payment for a MIXED cart (ceramic + print).
 * Guards the split reservation path: the ceramic piece is reserved (piece_state),
 * the print is not, and both land in one order with the fulfillment guard counting
 * only the ceramic line.
 *
 *   PLAYWRIGHT_BASE_URL=https://anna-ciok.studio npx playwright test --grep @destructive
 */
const SUCCESS_CARD = '4242424242424242';

test.describe('@checkout @destructive mixed ceramic + print purchase', () => {
  test('buys a ceramic and a print together via paczkomat + card', async ({ page, context, baseURL }) => {
    if (/localhost|127\.0\.0\.1/.test(baseURL ?? '') && process.env.E2E_ALLOW_LOCALHOST !== '1') {
      test.skip(true, `baseURL is ${baseURL}; set E2E_ALLOW_LOCALHOST=1 to run @destructive locally.`);
    }

    await resetCart(page);
    await mockGeowidget(page, context);

    // One unique ceramic (reserved) + one print variant (open edition, not reserved).
    const ceramic = await addFirstUnsoldFromCategory(page, 'kubki');
    const token = await addPrintVariant(page, 'fap01', { size: 'a4', paper: 'matte', frame: 'none' });

    await goToCart(page);
    await expect(page.locator(sel.cartLine)).toHaveCount(2);
    await expect(page.locator(`${sel.cartLine}[data-product-id="${ceramic.id}"]`)).toBeVisible();
    await expect(page.locator(`${sel.cartLine}[data-product-id="${token}"]`)).toBeVisible();

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
