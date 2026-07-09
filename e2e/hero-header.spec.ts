import { test, expect } from '@playwright/test';

// `@ci` in each title so `playwright test --grep @ci` selects these.
test('@ci header shrinks on scroll', async ({ page }) => {
  await page.goto('/');
  const header = page.locator('#site-header');
  const tall = (await header.boundingBox())!.height;
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await header.boundingBox())!.height).toBeLessThan(tall);
});

test('@ci header does not shrink under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const header = page.locator('#site-header');
  const tall = (await header.boundingBox())!.height;
  await page.mouse.wheel(0, 200);
  // Deterministic wait: the scroll has landed and a frame has painted — if the
  // shrink animation were (wrongly) active, it would have applied by now.
  await page.waitForFunction(() => window.scrollY > 0);
  await page.evaluate(() => new Promise(requestAnimationFrame));
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
