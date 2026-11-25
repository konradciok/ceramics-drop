import { test, expect, type Page } from '@playwright/test';
import { COOKIE_NAME } from '../src/components/consent/consent-mode';

/**
 * Mobile listing guards (conversion audit 2026-11-25, T4): at 390px a tile's
 * price wrapped onto two lines ("119" / "zł"), the PDP "more from" row ran the
 * name into the price, and the cookie banner covered the hero CTA on the first
 * screen. @ci-safe — read-only page loads (the CTA click only navigates).
 */
const PHONE = { width: 390, height: 844 };

/** Any `.pr` taller than ~1.5 lines means the price wrapped. */
async function wrappedPrices(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) =>
    els
      .filter((el) => {
        const lh = parseFloat(getComputedStyle(el).lineHeight);
        return el.getBoundingClientRect().height > lh * 1.5;
      })
      .map((el) => el.textContent),
  );
}

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('mobile tiles and consent banner @ci', () => {
  test.describe('with a consent choice already made', () => {
    test.beforeEach(async ({ context, baseURL }) => {
      await context.addCookies([{ name: COOKIE_NAME, value: 'denied', url: baseURL! }]);
    });

    for (const path of ['/sklep', '/de/sklep', '/kubki']) {
      test(`390px ${path}: every tile price stays on one line, no horizontal scroll`, async ({ page }) => {
        await page.setViewportSize(PHONE);
        await page.goto(path);
        await expect(page.locator('[data-testid="product-tile"]').first()).toBeVisible();
        expect(await page.locator('.tile-meta .pr').count()).toBeGreaterThan(0);
        expect(await wrappedPrices(page, '.tile-meta .pr')).toEqual([]);
        expect(await horizontalOverflow(page), 'tiles must not widen the grid past the viewport').toBe(0);
      });
    }

    test('390px PDP "more from": name and price do not collide', async ({ page }) => {
      await page.setViewportSize(PHONE);
      await page.goto('/kubki');
      const href = await page.locator('[data-testid="product-tile"] .tile-link').first().getAttribute('href');
      await page.goto(href!);
      const metas = page.locator('.pdp-more .tile-static-meta');
      await expect(metas.first()).toBeAttached();
      const collisions = await metas.evaluateAll((els) =>
        els.filter((m) => {
          const a = m.querySelector('.nm')!.getBoundingClientRect();
          const b = m.querySelector('.pr')!.getBoundingClientRect();
          return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        }).length,
      );
      expect(collisions).toBe(0);
      expect(await wrappedPrices(page, '.pdp-more .tile-static-meta .pr')).toEqual([]);
    });
  });

  test('390px home: hero CTA stays visible and tappable while the consent banner is open', async ({ page, context }) => {
    await context.clearCookies();
    await page.setViewportSize(PHONE);
    await page.goto('/');
    const banner = page.locator('[role="dialog"].consent');
    await expect(banner).toBeVisible({ timeout: 8_000 });

    const cta = page.locator('.hero-actions .btn-primary');
    await expect(cta).toBeInViewport();
    // Wait for the lift transition, then check nothing sits on top of the CTA.
    await expect
      .poll(async () => {
        const [c, b] = await Promise.all([cta.boundingBox(), banner.boundingBox()]);
        return c!.y + c!.height <= b!.y;
      })
      .toBe(true);
    const ctaOnTop = await cta.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    expect(ctaOnTop, 'the consent banner must not cover the hero CTA').toBe(true);

    // Tapping it works with the banner still open (and the banner stays open:
    // navigating is not a consent choice).
    await cta.click();
    await page.waitForURL(/\/sklep$/);
    await expect(banner).toBeVisible();
  });
});
