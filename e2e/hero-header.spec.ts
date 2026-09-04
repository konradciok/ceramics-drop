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

test('@ci homepage print rail heading renders and is visible under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.prints-home .section-title')).toBeVisible();
});

test('@ci homepage print rail renders 5 daily-rotated tiles linking to print PDPs', async ({ page }) => {
  await page.goto('/');
  const tiles = page.locator('.prints-home .prints-home-card');
  await expect(tiles).toHaveCount(5);
  const hrefs = await tiles.evaluateAll((links) => links.map((l) => l.getAttribute('href')));
  for (const href of hrefs) {
    expect(href).toMatch(/fine-art-prints\//);
  }
});

test('@ci hero media renders (no-CMS static fallback)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.hero-media img')).toBeVisible();
});
