import { test, expect } from '@playwright/test';

// `@ci` in each title so `playwright test --grep @ci` selects these.
test('@ci header shrinks on scroll', async ({ page }) => {
  await page.goto('/');
  const header = page.locator('#site-header');
  const tall = (await header.boundingBox())!.height;
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(150);
  const short = (await header.boundingBox())!.height;
  expect(short).toBeLessThan(tall);
});

test('@ci header does not shrink under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const header = page.locator('#site-header');
  const tall = (await header.boundingBox())!.height;
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(150);
  expect((await header.boundingBox())!.height).toBe(tall);
});

test('@ci hero CTA is in the first viewport before scroll (mobile + desktop)', async ({ page }) => {
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(vp);
    await page.goto('/');
    await expect(page.locator('.hero-actions .btn-primary')).toBeInViewport();
  }
});

test('@ci hero beat caption renders and is visible under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.hero-beat-cap')).toBeVisible();
});
