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
});
