import { test, expect } from '@playwright/test';

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
