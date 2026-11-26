import { test, expect, type Page } from '@playwright/test';
import { resetCart, appendToCart, goToCart, dismissConsent, mockGeowidget, mockLockerSelection, sel } from './helpers/checkout';

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

  test('the only delivery method is a fact, not a choice, and the InPost map can be closed', async ({ page }) => {
    const country = page.getByTestId('delivery-country');
    await country.selectOption('PL');
    // Lockers are the only method on offer (courier and pickup are off): no
    // one-option radio group, just the method and its price.
    await expect(page.locator(sel.shippingPaczkomat)).toBeVisible();
    await expect(page.locator(`${sel.shippingPaczkomat} input[type="radio"]`)).toHaveCount(0);
    await expect(page.locator('#cart-root [role="radiogroup"]')).toHaveCount(0);
    await page.locator('[data-testid="choose-locker"]').click();
    await expect(page.locator('inpost-geowidget')).toBeAttached();
    await page.getByTestId('close-locker-map').click();
    await expect(page.locator('inpost-geowidget')).toHaveCount(0);
    await expect(page.locator('[data-testid="choose-locker"]')).toBeVisible();
  });
});

test.describe('InPost map on a phone @ci', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page, context }) => {
    await mockGeowidget(page, context);
    await openCart(page);
    await page.getByTestId('delivery-country').selectOption('PL');
  });

  test('opens as a full-screen sheet that locks the page and closes on Escape', async ({ page }) => {
    await page.getByTestId('choose-locker').click();
    const sheet = page.getByTestId('locker-map');
    await expect(sheet).toHaveAttribute('role', 'dialog');
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    const box = await sheet.boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await expect(page.getByTestId('close-locker-map')).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    await page.keyboard.press('Escape');
    await expect(page.locator('inpost-geowidget')).toHaveCount(0);
    await expect(page.getByTestId('choose-locker')).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  });

  test('a picked point closes the sheet and focus lands on "change"', async ({ page }) => {
    await page.getByTestId('choose-locker').click();
    await mockLockerSelection(page);
    await expect(page.getByTestId('locker-map')).toHaveCount(0);
    await expect(page.getByTestId('change-locker')).toBeFocused();
  });
});

test.describe('InPost map on a wide screen @ci', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page, context }) => {
    await mockGeowidget(page, context);
    await openCart(page);
    await page.getByTestId('delivery-country').selectOption('PL');
  });

  test('stays inline in the delivery form, without a modal', async ({ page }) => {
    await page.getByTestId('choose-locker').click();
    const sheet = page.getByTestId('locker-map');
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toHaveAttribute('role', 'dialog');
    await expect(page.locator('#delivery-form [data-testid="locker-map"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  });
});
