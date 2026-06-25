import { test, expect } from '@playwright/test';
import { resetCart, addFirstUnsoldFromCategory, goToCart, selectPaczkomat, blockGeowidget, sel } from './helpers/checkout';

// Failure path: the InPost Geowidget script is blocked or its token is missing.
// Expected: the app shows delivery.lockerUnavailable copy and keeps checkout
// disabled (no locker selectable → lockerReady is false in CartView).
// @ci-safe — fully self-contained via request interception; no real checkout occurs.
test.describe('@checkout-edge @ci geowidget unavailable', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page, context }) => {
    await resetCart(page);
    await blockGeowidget(context);
  });

  test('shows blocker copy and disables checkout when the widget cannot load', async ({ page }) => {
    // Category verified against src/lib/products.ts; helper picks first unsold tile.
    await addFirstUnsoldFromCategory(page, 'kubki');
    await goToCart(page);
    await selectPaczkomat(page);

    // delivery.lockerUnavailable (messages/pl.json). GeowidgetPicker only flips to
    // the fallback after an 8s whenDefined timeout, so allow 15s here.
    await expect(page.getByText(/Wybór paczkomatu jest chwilowo niedostępny/i)).toBeVisible({
      timeout: 15_000,
    });

    // No locker can be chosen and checkout must not proceed.
    await expect(page.locator(sel.selectedLocker)).toHaveCount(0);
    await expect(page.locator(sel.checkoutButton)).toBeDisabled();
  });
});
