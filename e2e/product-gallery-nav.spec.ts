import { test, expect } from '@playwright/test';

// w12 (miski-falowane) carries one merged gallery image on top of its main
// photo — two slides, the most any ceramic registry piece has.
const PDP_URL = '/miski-falowane/w12';

// Skipped while miski-falowane is withdrawn (HIDDEN_CATEGORIES → its PDPs 404)
// and no visible registry piece has a multi-image gallery. Re-enable when the
// family returns or another visible piece gains a GALLERY_MERGE entry.
test.describe.skip('product gallery navigation @ci', () => {
  test('desktop chevrons step through slides and disable at the bounds', async ({ page }) => {
    await page.goto(PDP_URL);
    const prev = page.locator('.pdp-img-nav.lb-prev');
    const next = page.locator('.pdp-img-nav.lb-next');

    await expect(prev).toBeDisabled();
    await expect(page.locator('.pdp-img-dot').nth(0)).toHaveClass(/active/);

    await next.click();
    await expect(page.locator('.pdp-img-dot').nth(1)).toHaveClass(/active/);
    await expect(prev).toBeEnabled();
    await expect(next).toBeDisabled();

    await prev.click();
    await expect(page.locator('.pdp-img-dot').nth(0)).toHaveClass(/active/);
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
    await page.locator('.pdp-img-dot').nth(1).click();

    await page.locator('.pdp-img-expand').click();
    const lb = page.locator('.lb.open');
    await expect(lb).toBeVisible();
    await expect(lb.locator('.lb-dot').nth(1)).toHaveClass(/active/);
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
    await expect(lb.locator('.lb-nav.lb-next')).toBeDisabled();

    await lb.locator('.lb-dot').nth(0).click();
    await expect(lb.locator('.lb-dot').nth(0)).toHaveClass(/active/);
    await lb.locator('.lb-dot').nth(1).click();

    // Closing leaves the inline gallery in sync with where the lightbox left off.
    await page.keyboard.press('Escape');
    await expect(page.locator('.pdp-img-dot').nth(1)).toHaveClass(/active/);
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
