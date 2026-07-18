import { test, expect } from '@playwright/test';
import { resetCart, addFirstUnsoldFromCategory, goToCart } from './helpers/checkout';

/**
 * Accessible names + keyboard access (audit P1): tile overlay anchors and
 * cart thumbnails were empty links, and purchasable tiles had no keyboard
 * path to the lightbox at all.
 * @ci-safe — read-only page interactions plus local cart state.
 */
test.describe('tile and cart link a11y @ci', () => {
  test('gallery tile link carries name/price and Enter opens the lightbox', async ({ page }) => {
    await page.goto('/kubki');
    const tile = page
      .locator('[data-testid="product-tile"]:not([data-sold="true"]):not([data-showroom="true"])')
      .first();
    await expect(tile).toBeVisible();

    const link = tile.locator('.tile-link');
    await expect(link).toHaveAccessibleName(/Nº \d+ — /);

    await link.focus();
    await page.keyboard.press('Enter');
    // Name-scoped: the mobile drawer and consent banner are dialogs too.
    await expect(page.getByRole('dialog', { name: /Nº \d+/ })).toBeVisible();
    // Same URL — the purchasable tile opens the quick view, not a navigation.
    expect(new URL(page.url()).pathname.endsWith('/kubki')).toBe(true);
  });

  test('cart and summary thumbnails link to the piece PDP with a name', async ({ page }) => {
    await resetCart(page);
    const picked = await addFirstUnsoldFromCategory(page, 'kubki');
    await goToCart(page);

    const rowThumb = page.locator('.cart-row .thumb');
    await expect(rowThumb).toHaveAccessibleName(/Nº \d+/);
    await expect(rowThumb).toHaveAttribute('href', new RegExp(`/kubki/${picked.id}$`));

    const sumThumb = page.locator('.sum-item-thumb');
    await expect(sumThumb).toHaveAccessibleName(/Nº \d+/);
    await expect(sumThumb).toHaveAttribute('href', new RegExp(`/kubki/${picked.id}$`));
  });
});
