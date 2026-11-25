import { test, expect, type Page } from '@playwright/test';
import { sel } from './helpers/checkout';

/**
 * An explicit language choice outlives Accept-Language detection (@ci, hermetic).
 *
 * Regression for T1 in docs/plans/2026-11-25-conversion-audit-action-plan.md:
 * an en-US browser that picked PL was bounced back to /en/* (and EUR) on the
 * next link, because `/en/*` prefetches issued by the page it had just left
 * landed afterwards and next-intl re-synced NEXT_LOCALE to `en`.
 */

async function chooseLocale(page: Page, label: 'PL' | 'EN'): Promise<void> {
  await page.locator('.nav-right .lang-switch').getByRole('button', { name: label, exact: true }).click();
}

/** Unprefixed URL, Polish document, prices in złoty. */
async function expectPolish(page: Page, path: string | RegExp): Promise<void> {
  await expect(page).toHaveURL(typeof path === 'string' ? new RegExp(`^[^?#]*//[^/]+${path}(?:[?#]|$)`) : path);
  await expect(page.locator('html')).toHaveAttribute('lang', 'pl');
}

test.describe('explicit locale choice sticks @ci', () => {
  test.describe('en-US browser', () => {
    test.use({ locale: 'en-US' });

    test('first visit to / is still detected as English', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/en$/);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    });

    test('after choosing PL, links, reload, back and typed URLs stay Polish in zł', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/en$/);
      // Let the /en page start prefetching its links — those in-flight /en/*
      // prefetches are what used to flip the cookie back after the switch.
      await page.waitForLoadState('networkidle');

      await chooseLocale(page, 'PL');
      await expectPolish(page, '/');
      await page.waitForLoadState('networkidle');

      // Home → hero CTA → shop.
      await page.locator('.hero-actions .btn-primary').click();
      await expectPolish(page, '/sklep');
      await expect(page.locator('.tile-meta .pr').first()).toContainText('zł');

      // Shop → a family collection.
      const card = page.getByTestId('ceramic-shop-families').getByTestId('collection-card').first();
      const categoryHref = await card.getAttribute('href');
      expect(categoryHref).toMatch(/^\/[a-z-]+$/);
      await card.click();
      await expectPolish(page, categoryHref!);
      await expect(page.locator('.tile-meta .pr').first()).toContainText('zł');

      // Collection → PDP (tile links are crawlable hrefs; a purchasable tile's
      // click opens the lightbox, so follow the href directly).
      const pdpHref = await page.locator(sel.productTile).first().locator('a.tile-link').getAttribute('href');
      expect(pdpHref).toMatch(/^\/[a-z-]+\/[a-z0-9]+$/);
      await page.goto(pdpHref!);
      await expectPolish(page, pdpHref!);
      await expect(page.locator('.pdp-price')).toContainText('zł');

      // PDP → cart.
      await page.locator('#site-header a[href="/koszyk"]').click();
      await expectPolish(page, '/koszyk');

      await page.reload();
      await expectPolish(page, '/koszyk');

      await page.goBack();
      await expectPolish(page, pdpHref!);
      await expect(page.locator('.pdp-price')).toContainText('zł');

      // A typed unprefixed URL is not re-detected from Accept-Language.
      await page.goto('/sklep');
      await expectPolish(page, '/sklep');
      await expect(page.locator('.tile-meta .pr').first()).toContainText('zł');
    });
  });

  test.describe('pl-PL browser', () => {
    test.use({ locale: 'pl-PL' });

    test('after choosing EN, links and typed URLs stay on /en', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'pl');
      await page.waitForLoadState('networkidle');

      await chooseLocale(page, 'EN');
      await expect(page).toHaveURL(/\/en$/);
      await page.waitForLoadState('networkidle');

      await page.locator('.hero-actions .btn-primary').click();
      await expect(page).toHaveURL(/\/en\/sklep$/);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');

      await page.goto('/sklep');
      await expect(page).toHaveURL(/\/en\/sklep$/);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    });
  });
});
