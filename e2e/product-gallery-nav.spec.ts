import { test, expect } from '@playwright/test';

// fap005 has 3 editorialGallery slides (4 images total) — same fixture used by
// print-configurator.spec.ts for gallery-shaped assertions.
const PDP_URL = '/fine-art-prints/fap005';

test.describe('product gallery navigation @ci', () => {
  test('desktop chevrons step through slides and disable at the bounds', async ({ page }) => {
    await page.goto(PDP_URL);
    const prev = page.locator('.pdp-img-nav.lb-prev');
    const next = page.locator('.pdp-img-nav.lb-next');

    await expect(prev).toBeDisabled();
    await expect(page.locator('.pdp-img-dot').nth(0)).toHaveClass(/active/);

    await next.click();
    await expect(page.locator('.pdp-img-dot').nth(1)).toHaveClass(/active/);
    await expect(prev).toBeEnabled();

    await next.click();
    await next.click();
    await expect(page.locator('.pdp-img-dot').nth(3)).toHaveClass(/active/);
    await expect(next).toBeDisabled();

    await prev.click();
    await expect(page.locator('.pdp-img-dot').nth(2)).toHaveClass(/active/);
  });

  test('arrow keys step through slides once the gallery is focused', async ({ page }) => {
    await page.goto(PDP_URL);
    await page.locator('.pdp-img-main').focus();

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.pdp-img-dot').nth(1)).toHaveClass(/active/);

    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.pdp-img-dot').nth(0)).toHaveClass(/active/);
  });

  test('expand button opens a lightbox on the current slide', async ({ page }) => {
    await page.goto(PDP_URL);
    await page.locator('.pdp-img-dot').nth(2).click();

    await page.locator('.pdp-img-expand').click();
    const lb = page.locator('.lb.open');
    await expect(lb).toBeVisible();
    await expect(lb.locator('.lb-dot').nth(2)).toHaveClass(/active/);
  });

  test('lightbox: Escape closes and returns focus to the expand button', async ({ page }) => {
    await page.goto(PDP_URL);
    const expandBtn = page.locator('.pdp-img-expand');
    await expandBtn.click();
    await expect(page.locator('.lb.open')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.lb.open')).toHaveCount(0);
    await expect(expandBtn).toBeFocused();
  });

  test('lightbox: chevrons and dots page through the same images as the inline gallery', async ({ page }) => {
    await page.goto(PDP_URL);
    await page.locator('.pdp-img-expand').click();

    const lb = page.locator('.lb.open');
    await lb.locator('.lb-nav.lb-next').click();
    await expect(lb.locator('.lb-dot').nth(1)).toHaveClass(/active/);

    await lb.locator('.lb-dot').nth(3).click();
    await expect(lb.locator('.lb-dot').nth(3)).toHaveClass(/active/);
    await expect(lb.locator('.lb-nav.lb-next')).toBeDisabled();

    // Closing leaves the inline gallery in sync with where the lightbox left off.
    await page.keyboard.press('Escape');
    await expect(page.locator('.pdp-img-dot').nth(3)).toHaveClass(/active/);
  });

  test('lightbox: clicking the backdrop (outside the card) closes it', async ({ page }) => {
    await page.goto(PDP_URL);
    await page.locator('.pdp-img-expand').click();
    await expect(page.locator('.lb.open')).toBeVisible();

    // `.lb` and `.lb-scrim` both cover the full viewport; the card only occupies
    // the center, so a corner click lands on backdrop (matches Lightbox.tsx's
    // target===currentTarget close-on-backdrop-click pattern).
    await page.locator('.lb.open').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.lb.open')).toHaveCount(0);
  });
});
