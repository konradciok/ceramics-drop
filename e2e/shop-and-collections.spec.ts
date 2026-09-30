import { test, expect } from '@playwright/test';
import { resetCart, CART_KEY } from './helpers/checkout';

/**
 * /kolekcje hub, /kolekcje/{slug} subpages and the /sklep shop (@ci, hermetic).
 *
 * Runs against the code-mode registry (no Supabase): collection copy is not
 * published there, so collection pages are noindex by design — assertions cover
 * routing, filtering, quick add and breadcrumbs, not indexable-page metadata.
 */
test.describe('@ci collections hub + shop', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.clearCookies();
    await resetCart(page);
  });

  test('hub lists collection cards that lead to a collection page and on to a print PDP', async ({ page }) => {
    await page.goto('/kolekcje');
    const cards = page.getByTestId('collection-card');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThan(1);

    const href = await cards.first().getAttribute('href');
    expect(href).toMatch(/^\/kolekcje\/[a-z0-9-]+$/);
    await cards.first().click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.locator('h1')).toBeVisible();

    await page.getByTestId('print-tile').first().click();
    await expect(page).toHaveURL(/\/fine-art-prints\/fap\d+$/);
    // PDP breadcrumb runs through the collection: Home › Kolekcje › {collection} › print.
    await expect(page.locator('.pdp-breadcrumb a[href="/kolekcje"]')).toBeVisible();
    await expect(page.locator(`.pdp-breadcrumb a[href="${href}"]`)).toBeVisible();
  });

  // Long series names ("Cumulonimbus") once pushed the two-up phone grid wider than the viewport.
  test('hub, a collection page and the shop never scroll horizontally at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    for (const path of ['/kolekcje', '/kolekcje/cumulonimbus', '/sklep']) {
      await page.goto(path);
      await expect(page.locator('h1')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} must not scroll horizontally`).toBe(0);
    }
  });

  test('an unknown collection slug is a real 404', async ({ request }) => {
    const response = await request.get('/kolekcje/nonexistent-collection', { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });

  test('shop colour filter narrows the grid, syncs the URL and clears', async ({ page }) => {
    await page.goto('/sklep');
    const tiles = page.getByTestId('print-tile');
    await expect(tiles.first()).toBeVisible();
    const all = await tiles.count();

    await page.getByTestId('filter-colour-blue').click();
    await expect(page).toHaveURL(/[?&]kolor=blue/);
    await expect.poll(() => tiles.count()).toBeLessThan(all);
    // Editorial bands only interrupt the unfiltered grid.
    await expect(page.locator('.shop-promo')).toHaveCount(0);

    await page.getByTestId('filter-clear').click();
    await expect(page).not.toHaveURL(/kolor=/);
    await expect.poll(() => tiles.count()).toBe(all);
  });

  test('a shared filtered link renders already filtered', async ({ page, request }) => {
    const filtered = await request.get('/sklep?kolor=blue');
    const unfiltered = await request.get('/sklep');
    const count = (html: string) => (html.match(/data-testid="print-tile"/g) ?? []).length;
    const filteredCount = count(await filtered.text());
    expect(filteredCount).toBeGreaterThan(0);
    expect(filteredCount).toBeLessThan(count(await unfiltered.text()));

    await page.goto('/sklep?kolor=blue');
    await expect(page.getByTestId('filter-colour-blue')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the canonical never carries the filter query', async ({ page }) => {
    await page.goto('/sklep?kolor=blue&sort=new');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/sklep$/);
  });

  test('sorting by newest puts a different design first', async ({ page }) => {
    await page.goto('/sklep');
    const first = () => page.getByTestId('print-tile').first().getAttribute('data-product-id');
    const featuredFirst = await first();
    await page.getByTestId('sort-select').selectOption('new');
    await expect(page).toHaveURL(/sort=new/);
    await expect.poll(first).not.toBe(featuredFirst);
  });

  test('quick add puts the chosen print variant in the cart', async ({ page }) => {
    await page.goto('/sklep');
    await page.getByTestId('quick-add-open').first().click();
    const dialog = page.getByTestId('print-quick-add');
    await expect(dialog).toBeVisible();

    await dialog.getByTestId('opt-size-50x70').click();
    await dialog.getByTestId('print-add').click();
    await expect(page.locator('[data-cart-count]')).toHaveText('1');

    const ids = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}').state?.ids as string[], CART_KEY);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^print:fap\d+:50x70:false:false:none$/);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
