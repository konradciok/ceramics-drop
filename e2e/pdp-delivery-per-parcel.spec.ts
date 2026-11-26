import { test, expect, type Page } from '@playwright/test';
import { resetCart, appendToCart, goToCart, dismissConsent, mockGeowidget, sel } from './helpers/checkout';

/**
 * T6 (docs/plans/2026-11-25-conversion-audit-action-plan.md): the PDP names
 * the visitor's own country and its delivery price when it is known, says the
 * fee covers the whole parcel and that parcels leave from Spain; the PDP and
 * the cart carry the damage-guarantee + 14-day-return line.
 * @ci-safe — display only. Every piece is purchasable thanks to
 * E2E_CERAMIC_SALE_FIXTURE (playwright.config.ts); `next start` sends no
 * CF-IPCountry and has no CMS, so the code shipping table applies: kubki
 * PLN 95 / EUR 25, lockers Spain PLN 43 / EUR 10, other countries PLN 65 / EUR 15.
 */

const PIECE = 'k01';
const PDP = `/kubki/${PIECE}`;

async function saveDeliveryCountry(page: Page, baseURL: string | undefined, country: string) {
  await page.context().addCookies([{ name: 'delivery_country', value: country, url: baseURL ?? 'http://localhost:3000' }]);
}

test.describe('PDP delivery: this visitor, per parcel @ci', () => {
  test('pl without CF-IPCountry names Poland and its price, per parcel, shipped from Spain', async ({ page }) => {
    await page.goto(PDP);
    const block = page.getByTestId('pdp-delivery');
    await expect(block).toHaveAttribute('data-country-known', 'true');
    await expect(block.locator('.pdp-delivery-opts li')).toHaveCount(1);
    const row = block.getByTestId('pdp-locker-country');
    await expect(row.locator('span').first()).toHaveText(/Polska/);
    await expect(row.locator('span').nth(1)).toHaveText(/^65\s*zł$/);
    await expect(block.locator('.pdp-delivery-est .k')).toHaveText('Razem z dostawą');
    await expect(page.getByTestId('pdp-est-total')).toHaveText(/^160\s*zł$/);
    await expect(page.getByTestId('pdp-per-parcel')).toContainText('całej paczki');
    await expect(page.getByTestId('pdp-per-parcel')).toContainText('w Hiszpanii');
    await expect(page.getByTestId('pdp-per-parcel')).toContainText('do 7 dni roboczych');
  });

  test("the country saved in the cart wins: Spain on /en quotes Spain's lane", async ({ page, baseURL }) => {
    await saveDeliveryCountry(page, baseURL, 'ES');
    await page.goto(`/en${PDP}`);
    const row = page.getByTestId('pdp-locker-country');
    await expect(row.locator('span').first()).toHaveText(/Spain/);
    // Spain's lane is the mainland and the Balearics (T10): the row says so.
    await expect(row.locator('span').first()).toContainText('Balearic');
    await expect(row.locator('span').nth(1)).toHaveText(/^10\s*€$/);
    await expect(page.getByTestId('pdp-est-total')).toHaveText(/^35\s*€$/);
    await expect(page.getByTestId('pdp-per-parcel')).toContainText('up to 4 business days');
  });

  test('a guessed country (en, no IP country) keeps one row per zone', async ({ page }) => {
    await page.goto(`/en${PDP}`);
    const block = page.getByTestId('pdp-delivery');
    await expect(block).toHaveAttribute('data-country-known', 'false');
    await expect(block.locator('.pdp-delivery-opts li')).toHaveCount(2);
    await expect(block.getByTestId('pdp-locker-es').locator('span').first()).toContainText('Balearic');
    await expect(block.getByTestId('pdp-locker-es').locator('span').nth(1)).toHaveText(/^10\s*€$/);
    await expect(block.getByTestId('pdp-locker-eu').locator('span').nth(1)).toHaveText(/^15\s*€$/);
    await expect(block.locator('.pdp-delivery-est .k')).toHaveText('Estimated from');
    await expect(page.getByTestId('pdp-per-parcel')).toContainText('whole parcel');
    await expect(page.getByTestId('pdp-per-parcel')).not.toContainText('business days;');
  });

  test('the assurance line sits under the add-to-cart button and links to the policy sections', async ({ page }) => {
    await page.goto(PDP);
    const line = page.locator('.pdp-body [data-testid="purchase-assurance"]');
    await expect(line).toBeVisible();
    await expect(line.locator('a[href="/dostawa-i-zwroty#uszkodzenia"]')).toBeVisible();
    await expect(line.locator('a[href="/dostawa-i-zwroty#zwroty"]')).toContainText('14 dni');
    // Directly after the inline button.
    const follows = await page
      .locator('.pdp-body [data-testid="ceramic-add"] + [data-testid="purchase-assurance"]')
      .count();
    expect(follows).toBe(1);
  });
});

test.describe('cart: per-parcel delivery and the assurance line @ci', () => {
  test('the summary says the fee is per parcel; the assurance sits above the pay button', async ({ page, context }) => {
    await mockGeowidget(page, context);
    await page.route('**/api/inventory', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sold: [], showroom: [], available: [PIECE], activeDrops: [] }),
      }),
    );
    await resetCart(page);
    await page.goto('/');
    await appendToCart(page, PIECE);
    await goToCart(page);
    await dismissConsent(page);
    await expect(page.locator(sel.cartLine)).toHaveCount(1);

    await expect(page.getByTestId('summary-per-parcel')).toHaveText(/całą paczkę/);
    const cta = page.locator('.cart-cta');
    await expect(cta.getByTestId('purchase-assurance')).toBeVisible();
    expect(await cta.locator('[data-testid="purchase-assurance"] + #checkout').count()).toBe(1);
  });
});
