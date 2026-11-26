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

test('@ci homepage family grid heading renders and is visible under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByTestId('home-families').locator('.section-title')).toBeVisible();
});

test('@ci homepage family cards link to ceramic categories; prints link out to the print shop', async ({ page }) => {
  await page.goto('/');
  const cards = page.getByTestId('home-families').getByTestId('collection-card');
  await expect(cards.first()).toBeVisible();
  const hrefs = await cards.evaluateAll((links) => links.map((l) => l.getAttribute('href')));
  for (const href of hrefs) {
    expect(href).not.toMatch(/fine-art-prints|kolekcje/);
  }
  await expect(page.getByTestId('home-prints-moved').locator('a.section-link')).toHaveAttribute(
    'href',
    'https://anna-ciok.com/pl',
  );
  // No print PDP link survives anywhere on the page.
  await expect(page.locator('a[href*="/fine-art-prints/"]')).toHaveCount(0);
});

test('@ci hero media renders (no-CMS static fallback)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.hero-media img')).toBeVisible();
});

test('@ci announcement bar promotes the live drop and stays on the site', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('announce').locator('a')).toHaveAttribute('href', '/sklep');
  // Locale-aware: an English visitor stays in English.
  await page.goto('/en');
  await expect(page.getByTestId('announce').locator('a')).toHaveAttribute('href', '/en/sklep');
});

test('@ci homepage shows purchasable pieces with prices right under the hero', async ({ page }) => {
  await page.goto('/');
  const row = page.getByTestId('home-pieces');
  const tiles = row.getByTestId('product-tile');
  await expect(tiles.first()).toBeVisible();
  const count = await tiles.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(8);
  // Only buyable pieces, each with a price.
  await expect(row.locator('[data-testid="product-tile"][data-sold="true"]')).toHaveCount(0);
  await expect(row.locator('[data-testid="product-tile"][data-showroom="true"]')).toHaveCount(0);
  await expect(row.locator('.tile-meta .pr').first()).toContainText('zł');
  await expect(row.getByTestId('add-to-cart').first()).toBeEnabled();
  // Placed before the artist section.
  const order = await page.evaluate(() => {
    const pieces = document.querySelector('[data-testid="home-pieces"]')!;
    const studio = document.getElementById('studio')!;
    return pieces.compareDocumentPosition(studio) & Node.DOCUMENT_POSITION_FOLLOWING;
  });
  expect(order).toBeTruthy();
  await expect(row.locator('a.section-link')).toHaveAttribute('href', '/sklep');
});
