import { test, expect } from '@playwright/test';
import { COOKIE_NAME } from '../src/components/consent/consent-mode';

test.describe('@ci cookie consent banner', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test('shows on first visit; accept hides banner and persists consent', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.locator('[role="dialog"].consent')).toBeVisible({ timeout: 8_000 });

    await page.locator('.consent-accept').click();
    await expect(page.locator('[role="dialog"].consent')).not.toBeVisible();

    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === COOKIE_NAME)?.value).toBe('granted');

    await page.reload();
    await expect(page.locator('[role="dialog"].consent')).not.toBeVisible();
  });

  test('reject hides banner and sets denied cookie', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.locator('[role="dialog"].consent')).toBeVisible({ timeout: 8_000 });

    await page.locator('.consent-reject').click();
    await expect(page.locator('[role="dialog"].consent')).not.toBeVisible();

    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === COOKIE_NAME)?.value).toBe('denied');
  });

  test('"more info" link navigates to privacy policy (not 404)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[role="dialog"].consent')).toBeVisible({ timeout: 8_000 });

    await page.locator('.consent-more').click();
    await page.waitForURL(/polityka-prywatnosci/, { timeout: 8_000 });
    await expect(page.locator('h1')).toBeVisible();
  });

  // Withdrawal must be as easy as giving consent (GDPR Art. 7(3)): two clicks
  // from any page — the footer's "Cookie settings", then "Reject" — in every
  // locale. The footer link sits outside the (phone-collapsed) accordions.
  for (const path of ['/', '/en', '/es', '/de']) {
    test(`accept → "Cookie settings" → reject withdraws consent (${path})`, async ({ page, context, baseURL }) => {
      const banner = page.locator('[role="dialog"].consent');
      await page.goto(path);
      await expect(banner).toBeVisible({ timeout: 8_000 });
      await banner.locator('.consent-accept').click();
      await expect(banner).not.toBeVisible();

      // Stand-in for a cookie GA4 writes while consent is granted (GTM is not
      // loaded in the hermetic build). Withdrawal must remove it.
      await context.addCookies([{ name: '_ga', value: 'GA1.1.123.456', url: baseURL ?? page.url() }]);

      await page.locator('.footer-cookie-settings').click();
      await expect(banner).toBeVisible();
      await expect(banner.locator('.consent-current')).toBeVisible();

      // Withdrawal reloads the page so no tag loaded under consent survives.
      const reloaded = page.waitForEvent('load');
      await banner.locator('.consent-reject').click();
      await reloaded;

      const cookies = await context.cookies();
      expect(cookies.find((c) => c.name === COOKIE_NAME)?.value).toBe('denied');
      expect(cookies.find((c) => c.name === '_ga')).toBeUndefined();
      await expect(banner).not.toBeVisible();
    });
  }

  test('privacy policy reopens the banner; Escape closes it unchanged; accept re-grants', async ({ page, context }) => {
    const banner = page.locator('[role="dialog"].consent');
    await page.goto('/polityka-prywatnosci');
    await expect(banner).toBeVisible({ timeout: 8_000 });
    await banner.locator('.consent-reject').click();
    await expect(banner).not.toBeVisible();

    await page.locator('#cookies button').click();
    await expect(banner).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(banner).not.toBeVisible();
    expect((await context.cookies()).find((c) => c.name === COOKIE_NAME)?.value).toBe('denied');

    await page.locator('.footer-cookie-settings').click();
    await banner.locator('.consent-accept').click();
    await expect(banner).not.toBeVisible();
    expect((await context.cookies()).find((c) => c.name === COOKIE_NAME)?.value).toBe('granted');
  });
});
