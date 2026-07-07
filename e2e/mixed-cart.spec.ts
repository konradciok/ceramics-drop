import { test, expect } from '@playwright/test';
import { resetCart, addFirstUnsoldFromCategory, goToCart, fillContact, sel } from './helpers/checkout';

/**
 * Mixed-cart rejection (Findings 10 + 11) — ceramics and prints are separate
 * orders on every layer:
 *  1. the ceramic PDP blocks add-to-cart while a print is in the cart,
 *  2. a mixed cart (built via the tile shortcut) shows the notice and disables
 *     checkout,
 *  3. removing the print restores the ceramic path.
 * @ci-safe — cart state only; /api/checkout is never called.
 */
test.describe('mixed cart @ci', () => {
  test('print in cart blocks ceramic PDP add; mixed cart blocks checkout; removing the print unblocks', async ({ page }) => {
    await resetCart(page);

    // 1. Add a print via the configurator.
    await page.goto('/fine-art-prints/fap01');
    await page.getByTestId('opt-size-50x70').click();
    await page.getByTestId('print-add').click();
    await expect(page.locator('[data-cart-count]')).toHaveText('1');

    // 2. The ceramic PDP mirrors the guard: disabled button + mixed-cart note.
    await page.goto('/kubki');
    const firstUnsold = page.locator(`${sel.productTile}:not([data-sold="true"])`).first();
    await expect(firstUnsold, 'no unsold ceramic tile in /kubki').toBeVisible();
    const ceramicId = await firstUnsold.getAttribute('data-product-id');
    expect(ceramicId, 'ceramic tile has no data-product-id').toBeTruthy();
    await page.goto(`/kubki/${ceramicId}`);
    await expect(page.getByTestId('ceramic-add')).toBeDisabled();
    await expect(page.getByTestId('ceramic-mixed-note')).toBeVisible();

    // 3. The tile shortcut can still mix — the cart view must then refuse.
    const ceramic = await addFirstUnsoldFromCategory(page, 'kubki');
    await goToCart(page);
    await expect(page.getByTestId('mixed-cart-notice')).toBeVisible();
    await expect(page.locator(sel.checkoutButton)).toBeDisabled();

    // 4. Remove the print → ceramic checkout works again.
    const printLine = page.locator(`${sel.cartLine}[data-product-id^="print:"]`);
    await printLine.locator('button.rm').click();
    await expect(page.getByTestId('mixed-cart-notice')).toHaveCount(0);
    await expect(page.locator(`${sel.cartLine}[data-product-id="${ceramic.id}"]`)).toHaveCount(1);
    // Ceramic delivery options are back (prints would have hidden them)…
    await expect(page.locator('[data-testid="shipping-odbior"]')).toBeVisible();
    // …and with pickup + contact the checkout button actually arms.
    await page.locator('[data-testid="shipping-odbior"]').click();
    await fillContact(page);
    await expect(page.locator(sel.checkoutButton)).toBeEnabled();
  });
});
