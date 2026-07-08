import { test, expect } from '@playwright/test';

// bento is piloted on /kubki only. `@ci` lives in the titles so
// `playwright test --grep @ci` selects these.
test('@ci bento pilot heroes a lead tile and keeps available tiles shoppable', async ({ page }) => {
  await page.goto('/kubki');
  await expect(page.locator('.gallery--bento .tile--lead').first()).toBeVisible();
  // A live drop storefront sells through — the lead (index 0) may be sold.
  // Assert shoppability on the first AVAILABLE tile, not the sold lead.
  const availableTile = page.locator('[data-testid="product-tile"]:not(.sold)').first();
  await expect(availableTile.getByTestId('add-to-cart')).toBeVisible();
  await expect(availableTile.locator('.tile-meta .pr')).toBeVisible(); // price
});

test('@ci non-pilot category stays a uniform grid', async ({ page }) => {
  await page.goto('/wazony');
  await expect(page.locator('.gallery--bento')).toHaveCount(0);
});

test('@ci tiles are visible under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/kubki');
  const firstTile = page.locator('[data-testid="product-tile"]').first();
  await expect(firstTile).toBeVisible();
  // site.css forces .reveal to opacity:1 !important under reduced motion — assert
  // it on real bento markup so the @media guard is provably applied, not just present.
  await expect(firstTile).toHaveCSS('opacity', '1');
});
