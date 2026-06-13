import { test, expect } from '@playwright/test';
import { resetCart, goToCart, sel, CART_KEY } from './helpers/checkout';
import { pln } from '../src/lib/format';

/**
 * Non-destructive UI spec for the fine-art print configurator + cart rendering.
 * No payment is made. Requires the fine-art-prints category to be available at
 * the target base URL (run against a local build, or once the category ships).
 */
test.describe('print configurator', () => {
  test.beforeEach(async ({ page }) => {
    await resetCart(page);
  });

  test('updates the price live and adds the chosen variant token to the cart', async ({ page }) => {
    await page.goto('/fine-art-prints');
    await page.locator(sel.printTile).first().click();
    await expect(page.locator(sel.printConfigurator)).toBeVisible();

    // Default (a4 + matte + none) = 120 zł; a3 + satin + oak = 180 + 20 + 150 = 350 zł.
    await expect(page.locator(`${sel.printPrice} .v`)).toHaveText(pln(120));
    await page.locator('[data-testid="opt-size-a3"]').click();
    await page.locator('[data-testid="opt-paper-satin"]').click();
    await page.locator('[data-testid="opt-frame-oak"]').click();
    await expect(page.locator(`${sel.printPrice} .v`)).toHaveText(pln(350));

    await page.locator(sel.printAdd).click();
    const ids = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k) || '{}')?.state?.ids ?? [],
      CART_KEY,
    );
    expect(ids).toContain('print:fap01:a3:satin:oak');

    await goToCart(page);
    const line = page.locator(`${sel.cartLine}[data-product-id="print:fap01:a3:satin:oak"]`);
    await expect(line).toBeVisible();
    await expect(line.locator('.price')).toHaveText(pln(350));
  });

  test('disables an unavailable size/paper/frame combination', async ({ page }) => {
    // fap02 excludes a3:satin:black — selecting a3 + satin must disable the black frame.
    await page.goto('/fine-art-prints/fap02');
    await expect(page.locator(sel.printConfigurator)).toBeVisible();
    await page.locator('[data-testid="opt-size-a3"]').click();
    await page.locator('[data-testid="opt-paper-satin"]').click();
    await expect(page.locator('[data-testid="opt-frame-black"]')).toBeDisabled();
    await expect(page.locator('[data-testid="opt-frame-none"]')).toBeEnabled();
  });
});
