import { test, expect } from '@playwright/test';
import { resetCart, goToCart, sel } from './helpers/checkout';

/**
 * /sklep — the ceramics shop (@ci, hermetic). Fine-art prints moved to their
 * own shop, so /sklep lists the live drop's pieces on sale, then a card per
 * family, then (own section) every piece that cannot be bought right now. The
 * hermetic server runs with E2E_CERAMIC_SALE_FIXTURE (see playwright.config.ts),
 * so every registry piece reads as available; the sold/reserved split itself is
 * unit-tested in CeramicShopScreen.test.ts and status-filter.test.ts.
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
    await expect(page.locator('a[href^="https://anna-ciok.com"]')).toHaveCount(0);

    const cards = page.getByTestId('ceramic-shop-families').getByTestId('collection-card');
    expect(await cards.count()).toBeGreaterThan(1);
    const href = await cards.first().getAttribute('href');
    expect(href).toMatch(/^\/[a-z-]+$/);
    await cards.first().click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.locator(sel.productTile).first()).toBeVisible();
  });

  test('"available now" holds only buyable tiles and comes before the family cards', async ({ page }) => {
    await page.goto('/sklep');
    const available = page.getByTestId('ceramic-shop-available');
    const tiles = available.locator(sel.productTile);
    await expect(tiles.first()).toBeVisible();
    await expect(available.locator(`${sel.productTile}[data-sold="true"], ${sel.productTile}.reserved, ${sel.productTile}.showroom`)).toHaveCount(0);
    await expect(available.locator(`${sel.addToCart}:disabled`)).toHaveCount(0);

    const order = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="ceramic-shop-"]')].map((el) => el.getAttribute('data-testid')),
    );
    expect(order.slice(0, 2)).toEqual(['ceramic-shop-available', 'ceramic-shop-families']);
    // Every fixture piece is buyable, so the "not available right now" section is absent.
    await expect(page.getByTestId('ceramic-shop-unavailable')).toHaveCount(0);
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
