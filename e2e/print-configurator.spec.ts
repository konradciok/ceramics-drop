import { test, expect } from '@playwright/test';
import { PRINT_DESIGNS, registryPrintById } from '../src/lib/prints';

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

  test('styles selector controls and updates mounted variant price', async ({ page }) => {
    await page.goto('/fine-art-prints/fap01');

    await expect(page.locator('.print-axis').first()).toHaveCSS('border-width', '0px');
    await expect(page.getByTestId('opt-size-30x40')).toHaveAttribute('aria-checked', 'true');

    await page.getByTestId('opt-size-70x100').click();
    await expect(page.getByTestId('opt-size-30x40')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('opt-size-70x100')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('opt-framed-true').click();
    await page.getByTestId('opt-colour-natural').click();
    await page.getByTestId('opt-mount-true').click();

    await expect(page.getByTestId('opt-mount-true')).toHaveAttribute('aria-checked', 'true');
    // 720 zł = 70x100 base 190 + frame 485 + mount 45 (src/lib/print-pricing.ts).
    // Pinned literal: update here when SIZE_BASE / *_DELTA tables change.
    await expect(page.getByTestId('print-price')).toHaveText('720 zł');
  });

  test('hero mockup follows configurator selection', async ({ page }) => {
    const design = registryPrintById('fap01');
    test.skip(!design?.mockups, 'fap01 mockup assets not published yet (flag off)');

    await page.goto('/fine-art-prints/fap01');
    const hero = page.locator('.pdp-img-main img');
    await expect(hero).toHaveAttribute('src', '/uploads/fap-01.webp');

    // Framing defaults to the first colour (black).
    await page.getByTestId('opt-framed-true').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-01-mock-framed-black.webp');

    await page.getByTestId('opt-mount-true').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-01-mock-mount-black.webp');

    await page.getByTestId('opt-colour-natural').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-01-mock-mount-natural.webp');

    await page.getByTestId('opt-framed-false').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-01.webp');
  });

  test('design without mockups keeps a static hero', async ({ page }) => {
    const design = PRINT_DESIGNS.find((d) => d.published && !d.mockups && d.frameColours.length > 0);
    test.skip(!design, 'every published design already has mockups');

    await page.goto(`/fine-art-prints/${design!.id}`);
    const hero = page.locator('.pdp-img-main img');
    await expect(hero).toHaveAttribute('src', design!.image);
    await page.getByTestId('opt-framed-true').click();
    await expect(hero).toHaveAttribute('src', design!.image);
  });
});
