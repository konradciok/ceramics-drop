import { test, expect } from '@playwright/test';
import pl from '../messages/pl.json';

/**
 * Footer PSTR-style behavior guards: static link columns on desktop, four
 * independent collapsed-by-default accordions on mobile, 44px tap targets,
 * and no horizontal overflow at 320px.
 * @ci-safe — read-only page loads.
 */
test.describe('footer layout @ci', () => {
  test('desktop 1280px: link columns render open, headings are not toggles', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const footer = page.locator('.footer');
    await footer.scrollIntoViewIfNeeded();

    await expect(footer.locator('.facc')).toHaveCount(4);
    for (const panel of await footer.locator('.facc-panel').all()) {
      await expect(panel.locator('a').first()).toBeVisible();
    }
    // After hydration the desktop heading is a real <h5>, not an accordion button.
    await expect(footer.locator('h5.facc-head')).toHaveCount(4);
    await expect(footer.locator('.facc-head[aria-expanded]')).toHaveCount(0);

    await expect(footer.locator('.footer-pay .chip')).toHaveCount(6);
    // Newsletter island intact (checkout e2e helper relies on #cart-root
    // scoping precisely because this input exists on every page).
    await expect(page.getByTestId('newsletter-email')).toBeVisible();
  });

  test('mobile 375px: accordions collapsed by default, independent, 44px targets', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');
    const footer = page.locator('.footer');
    await footer.scrollIntoViewIfNeeded();

    const first = footer.locator('.facc').nth(0);
    const second = footer.locator('.facc').nth(1);
    await expect(first.locator('.facc-panel a').first()).toBeHidden();

    // Retry the click until hydration has attached the toggle handler.
    await expect(async () => {
      await first.locator('button.facc-head').click();
      await expect(first.locator('button.facc-head')).toHaveAttribute('aria-expanded', 'true', {
        timeout: 500,
      });
    }).toPass();
    await expect(first.locator('.facc-panel a').first()).toBeVisible();

    // Independent sections: opening the second keeps the first open.
    await second.locator('button.facc-head').click();
    await expect(second.locator('.facc-panel a').first()).toBeVisible();
    await expect(first.locator('.facc-panel a').first()).toBeVisible();

    // 44px tap-target convention (matches .icon-btn, .print-opt, .consent-btn).
    const head = await first.locator('button.facc-head').boundingBox();
    expect(head!.height).toBeGreaterThanOrEqual(44);
    const insta = await footer.locator('.footer-social a').boundingBox();
    expect(insta!.width).toBeGreaterThanOrEqual(44);
    expect(insta!.height).toBeGreaterThanOrEqual(44);

    await expect(page.getByTestId('newsletter-email')).toBeVisible();
  });

  test('320px: footer does not overflow horizontally', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/');
    await page.locator('.footer').scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'page must not scroll horizontally').toBe(0);
  });
});

/**
 * Link placement guards (conversion audit T7): the gift card pays for
 * ceramics only, so it sits under the ceramics column, and the header item
 * pointing at the /showroom archive must read as an archive — never like the
 * shop. Labels are matched against messages/pl.json so copy edits don't break
 * the guard, only a mis-wired link does.
 * @ci-safe — read-only page loads.
 */
test.describe('navigation and footer links @ci', () => {
  test('gift card link lives in the ceramics column, not under painting', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const footer = page.locator('.footer');
    await expect(footer.locator('#fshop-panel a[href="/karta-podarunkowa"]')).toHaveCount(1);
    await expect(footer.locator('#fart-panel a[href="/karta-podarunkowa"]')).toHaveCount(0);
  });

  test('header: the archive link is labelled as an archive, the shop link as the shop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const header = page.locator('#site-header');
    const shopLabel = pl.nav.sklep;
    const ceramicsLabel = pl.footer.hShop; // "Ceramika" — reads like the shop
    expect(pl.nav.showroom).not.toBe(shopLabel);
    expect(pl.nav.showroom).not.toBe(ceramicsLabel);

    for (const scope of [header.locator('.nav-left'), page.locator('.mob-nav')]) {
      const archive = scope.locator('a[href="/showroom"]');
      await expect(archive).toHaveCount(1);
      await expect(archive).toHaveText(pl.nav.showroom);
      await expect(scope.locator('a[href="/sklep"]')).toHaveText(shopLabel);
      // No shop-sounding item may point at the archive.
      for (const label of [shopLabel, ceramicsLabel]) {
        await expect(scope.locator('a[href="/showroom"]', { hasText: new RegExp(`^${label}$`) })).toHaveCount(0);
      }
    }
  });

  test('/showroom opens with a link to what is available now', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/showroom');
    const cta = page.getByTestId('showroom-shop-cta');
    await expect(cta).toHaveText(pl.showroom.shopCta);
    await expect(cta).toHaveAttribute('href', '/sklep');
    await expect(cta).toBeInViewport();
  });
});
