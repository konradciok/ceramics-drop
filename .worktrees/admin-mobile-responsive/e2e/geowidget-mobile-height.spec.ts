import { test, expect } from '@playwright/test';
import { resetCart, addFirstUnsoldFromCategory, goToCart, selectPaczkomat, mockGeowidget } from './helpers/checkout';

// Assert the geowidget container is tall enough on a mobile viewport so the
// InPost detail panel (Navigate / Select / Back to map) is never clipped.
// Uses the same stub seam as geowidget-unavailable.spec.ts — fully mocked, no
// real InPost assets loaded.
//
// NOT tagged @ci: CI runs against the production URL which only reflects merged
// CSS. Run this spec post-deploy against a preview URL:
//   PLAYWRIGHT_BASE_URL=<preview-url> npx playwright test geowidget-mobile-height
test.describe('geowidget mobile height', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page, context }) => {
    await resetCart(page);
    await mockGeowidget(page, context);
  });

  test('geowidget is at least 400 px tall on a 375×812 viewport', async ({ page }) => {
    await addFirstUnsoldFromCategory(page, 'kubki');
    await goToCart(page);
    await selectPaczkomat(page);

    const widget = page.locator('.geowidget');
    await expect(widget).toBeVisible();
    const box = await widget.boundingBox();
    expect(box, 'geowidget must be in the layout').not.toBeNull();
    expect(box!.height, 'geowidget must be tall enough for the InPost detail panel').toBeGreaterThanOrEqual(400);
  });
});
