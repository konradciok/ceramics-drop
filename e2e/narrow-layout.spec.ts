import { test, expect } from '@playwright/test';

/**
 * Narrow-width layout guards (audit P1/P2): the Polish status filter used to
 * overflow 320-375px viewports, and the header language/currency pills used
 * to collide with brand + cart at 561-860px on non-Polish locales.
 * @ci-safe — read-only page loads.
 */
test.describe('narrow-width layout @ci', () => {
  test('320px /sklep: no horizontal overflow, filter fits the gutter box', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/sklep');
    const filter = page.locator('.status-filter').first();
    await expect(filter).toBeVisible();

    const box = await filter.boundingBox();
    expect(box, 'status filter must be in the layout').not.toBeNull();
    expect(box!.width, 'filter must fit inside the 320px viewport').toBeLessThanOrEqual(320);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'page must not scroll horizontally').toBe(0);

    // 44px tap-target convention (matches .icon-btn, .print-opt, .consent-btn).
    const btn = await filter.locator('button').first().boundingBox();
    expect(btn!.height).toBeGreaterThanOrEqual(44);
  });

  test('600px German header: switch pills stay in the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto('/de/sklep');
    await expect(page.locator('.nav-right .lang-switch')).toHaveCount(2); // lang + currency
    for (const el of await page.locator('.nav-right .lang-switch').all()) {
      await expect(el).toBeHidden();
    }

    await page.setViewportSize({ width: 900, height: 800 });
    for (const el of await page.locator('.nav-right .lang-switch').all()) {
      await expect(el).toBeVisible();
    }
  });
});
