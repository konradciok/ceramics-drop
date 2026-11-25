import { test, expect, type Page } from '@playwright/test';
import { resetCart, appendToCart, goToCart, dismissConsent, mockGeowidget, sel } from './helpers/checkout';

/**
 * Small cart interactions: undo a removed piece, the email-domain hint, the
 * phone placeholder per country, the native delivery-method radio, and
 * closing the InPost map. Hermetic: one ceramic independent of live stock,
 * the Geowidget stubbed.
 * @ci-safe — display assertions only.
 */

const PIECE = 'k01';

async function openCart(page: Page): Promise<void> {
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
}

test.describe('cart interactions @ci', () => {
  test.beforeEach(async ({ page, context }) => {
    await mockGeowidget(page, context);
    await openCart(page);
  });

  test('a removed piece can be put back with Undo', async ({ page }) => {
    await page.locator(`${sel.cartLine} .rm`).click();
    await expect(page.getByTestId('cart-undo')).toBeVisible();
    await page.getByTestId('cart-undo-button').click();
    await expect(page.locator(sel.cartLine)).toHaveCount(1);
    await expect(page.getByTestId('cart-undo')).toHaveCount(0);
  });

  test('a near-miss email domain is offered as a one-tap fix', async ({ page }) => {
    const email = page.locator('#cart-root input[name="email"]');
    await email.fill('anna@gmial.com');
    await email.blur();
    await page.getByTestId('email-suggestion').click();
    await expect(email).toHaveValue('anna@gmail.com');
    await expect(page.getByTestId('email-suggestion')).toHaveCount(0);
  });

  test('the phone placeholder carries the destination dialling code', async ({ page }) => {
    const country = page.getByTestId('delivery-country');
    const phone = page.locator('#cart-root input[name="phone"]');
    await country.selectOption('PL');
    await expect(phone).toHaveAttribute('placeholder', '600 100 200');
    await country.selectOption('ES');
    await expect(phone).toHaveAttribute('placeholder', '+34 …');
  });

  test('the delivery method is a native radio, and the InPost map can be closed', async ({ page }) => {
    const country = page.getByTestId('delivery-country');
    await country.selectOption('PL');
    await expect(page.locator(`${sel.shippingPaczkomat} input[type="radio"]`)).toBeChecked();
    await page.locator('[data-testid="choose-locker"]').click();
    await expect(page.locator('inpost-geowidget')).toBeAttached();
    await page.getByTestId('close-locker-map').click();
    await expect(page.locator('inpost-geowidget')).toHaveCount(0);
    await expect(page.locator('[data-testid="choose-locker"]')).toBeVisible();
  });
});
