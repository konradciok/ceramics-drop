import { test, expect } from '@playwright/test';

test.describe('fine-art print configurator @ci', () => {
  test('renders configurator and adds print to cart', async ({ page }) => {
    await page.goto('/fine-art-prints/fap01');
    // Select 50x70
    await page.getByRole('button', { name: '50×70 cm' }).click();
    // Select framed
    await page.getByRole('button', { name: /w ramie|framed/i }).click();
    // Select black frame
    await page.getByRole('button', { name: /czarna|black/i }).click();
    // Add to cart
    await page.getByRole('button', { name: /dodaj|add to cart/i }).click();
    // Verify cart count increases
    await expect(page.getByTestId('cart-count')).toHaveText('1');
  });

  test('unframed variant shows no colour/mount selectors', async ({ page }) => {
    await page.goto('/fine-art-prints/fap01');
    await page.getByRole('button', { name: /bez ramy|no frame/i }).click();
    await expect(page.getByTestId('frame-colour-selector')).not.toBeVisible();
    await expect(page.getByTestId('mount-selector')).not.toBeVisible();
  });
});
