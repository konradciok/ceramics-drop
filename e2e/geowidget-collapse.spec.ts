import { test, expect } from '@playwright/test';
import {
  resetCart,
  addFirstUnsoldFromCategory,
  goToCart,
  selectPaczkomat,
  mockGeowidget,
  mockLockerSelection,
} from './helpers/checkout';

/**
 * Collapse-behind-button locker UX (audit P1): the 400px+ InPost map used to
 * sit between the contact fields and the pay CTA unconditionally on mobile.
 * Now it mounts only after "choose a locker" and collapses to the selected
 * point with a "change" action.
 * @ci-safe — mocked Geowidget seam; /api/checkout is never called.
 */
test.describe('geowidget collapse @ci', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ page, context }) => {
    await resetCart(page);
    await mockGeowidget(page, context);
  });

  test('map opens on intent and collapses to the chosen point', async ({ page }) => {
    await addFirstUnsoldFromCategory(page, 'kubki');
    await goToCart(page);

    // Before any intent: no map in the layout, just the choose button.
    await expect(page.locator('.geowidget')).toHaveCount(0);
    await expect(page.getByTestId('choose-locker')).toBeVisible();

    // selectPaczkomat clicks the method AND the choose button (shared helper).
    await selectPaczkomat(page);
    await expect(page.locator('.geowidget')).toBeVisible();

    await mockLockerSelection(page);

    // Selection collapses the map; the chosen point + change action remain.
    await expect(page.locator('.geowidget')).toHaveCount(0);
    await expect(page.getByTestId('selected-locker')).toContainText('WAW20A');
    const change = page.getByTestId('change-locker');
    await expect(change).toBeVisible();

    // Change re-opens the map without losing the current choice.
    await change.click();
    await expect(page.locator('.geowidget')).toBeVisible();
    await expect(page.getByTestId('selected-locker')).toContainText('WAW20A');
  });
});
