import { test, expect } from '@playwright/test';

test.describe('fine-art print configurator @ci', () => {
  test('renders configurator and adds print to cart', async ({ page }) => {
    await page.goto('/fine-art-prints/fap01');
    // Variant options render as radiogroup buttons (role="radio"), so they are
    // addressed by test id rather than the implicit button role.
    await page.getByTestId('opt-size-50x70').click();
    await page.getByTestId('opt-framed-true').click();
    await page.getByTestId('opt-colour-black').click();
    await page.getByTestId('print-add').click();
    // Header badge (CartCount) exposes the piece count via data-cart-count.
    await expect(page.locator('[data-cart-count]')).toHaveText('1');
  });

  test('unframed variant shows no colour/mount selectors', async ({ page }) => {
    await page.goto('/fine-art-prints/fap01');
    await page.getByTestId('opt-framed-false').click();
    await expect(page.getByTestId('opt-colour-black')).not.toBeVisible();
    await expect(page.getByTestId('opt-mount-false')).not.toBeVisible();
  });
});
