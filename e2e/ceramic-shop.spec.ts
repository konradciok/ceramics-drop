import { test, expect } from '@playwright/test';
import { resetCart, goToCart, sel } from './helpers/checkout';

/**
 * /sklep — the ceramics shop (@ci, hermetic). Fine-art prints moved to their
 * own shop, so /sklep lists every purchasable ceramic piece plus a card per
 * family. The hermetic server runs with E2E_CERAMIC_SALE_FIXTURE (see
 * playwright.config.ts), so every registry piece reads as available.
 */
test.describe('@ci ceramic shop', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.clearCookies();
    await resetCart(page);
  });

  test('lists available pieces and family cards that lead to a category', async ({ page }) => {
    await page.goto('/sklep');
    await expect(page.locator('h1')).toBeVisible();
    const available = page.getByTestId('ceramic-shop-available');
    await expect(available.locator(sel.productTile).first()).toBeVisible();
    // No print surface or print link survives on the shop page.
    await expect(page.locator('a[href*="/fine-art-prints/"], a[href*="/kolekcje"]')).toHaveCount(0);

    const cards = page.getByTestId('ceramic-shop-families').getByTestId('collection-card');
    expect(await cards.count()).toBeGreaterThan(1);
    const href = await cards.first().getAttribute('href');
    expect(href).toMatch(/^\/[a-z-]+$/);
    await cards.first().click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.locator(sel.productTile).first()).toBeVisible();
  });

  test('a piece added from the shop lands in the cart', async ({ page }) => {
    await page.goto('/sklep');
    const tile = page.getByTestId('ceramic-shop-available').locator(sel.productTile).first();
    await tile.locator(sel.addToCart).click();
    await expect(page.locator('[data-cart-count]')).toHaveText('1');
    await goToCart(page);
    await expect(page.locator(sel.cartLine)).toHaveCount(1);
  });

  test('the shop never scrolls horizontally at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/sklep');
    await expect(page.locator('h1')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, '/sklep must not scroll horizontally').toBe(0);
  });

  test('a stale print token in a returning visitor’s cart is dropped', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'acc_cart_v1',
        JSON.stringify({ state: { ids: ['print:fap005:50x70:false:false:none'] }, version: 0 }),
      );
    });
    await goToCart(page);
    await expect(page.locator('.cart-empty')).toBeVisible();
    await expect(page.locator(sel.cartLine)).toHaveCount(0);
  });
});
