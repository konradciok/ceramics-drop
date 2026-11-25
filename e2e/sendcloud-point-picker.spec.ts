import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { resetCart, appendToCart, goToCart, fillContact, sel } from './helpers/checkout';
import { DEFAULT_LOCKER_SHIPPING } from '../src/lib/pricing';

/**
 * Delivery country + Sendcloud point picker (shipping from Spain) — hermetic:
 * the server offers every enabled lane (the registry flags, as in production),
 * Sendcloud's picker script is blocked and its `sendcloud.servicePoints` API
 * stubbed, and /api/checkout is intercepted.
 * @ci-safe — display + request-shape assertions only.
 */

const SPAIN_POINT = {
  id: 10544,
  code: 'ES009299',
  name: 'Locker Mercado',
  carrier: 'inpost_es',
  street: 'Calle Mayor',
  house_number: '1',
  postal_code: '28013',
  city: 'Madrid',
  country: 'ES',
};

/**
 * Block embed.sendcloud.sc and pre-define the picker API, answering with
 * SPAIN_POINT. Call BEFORE page.goto(). Like the real SDK, the overlay removes
 * itself once it answers, and close() throws when no overlay is up.
 */
async function mockSendcloudPicker(page: Page, context: BrowserContext): Promise<void> {
  await context.route(/embed\.sendcloud\.sc/i, (route) => route.abort());
  await page.addInitScript((point) => {
    const w = window as unknown as Record<string, unknown>;
    const opened: unknown[] = [];
    w.__sppOpened = opened;
    w.sendcloud = {
      servicePoints: {
        // Answers at once, so no overlay is ever left up afterwards.
        open(config: { country: string }, onSuccess: (p: unknown, postNumber: string) => void) {
          opened.push(config);
          onSuccess({ ...point, country: config.country }, '');
        },
        close() {
          // Same failure as embed.sendcloud.sc's removeServicePointPicker.
          throw new TypeError("Cannot read properties of null (reading 'remove')");
        },
      },
    };
  }, SPAIN_POINT);
}

/** One ceramic in the cart, independent of live stock (same seam as promo-code.spec.ts). */
async function seedCeramic(page: Page): Promise<void> {
  await page.route('**/api/inventory', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sold: [], showroom: [], available: ['k01'], activeDrops: [] }),
    }),
  );
  await page.goto('/');
  await appendToCart(page, 'k01');
}

const lockerPrice = (pln: number) => new RegExp(`${pln}\\s*zł`);

test.describe('delivery country + Sendcloud point picker @ci', () => {
  test('Spain: the zone price, the Sendcloud picker, and the point id on the checkout POST', async ({ page, context }) => {
    await mockSendcloudPicker(page, context);
    await resetCart(page);
    await seedCeramic(page);
    await goToCart(page);

    const country = page.getByTestId('delivery-country');
    // pl locale without CF-IPCountry → Poland preselected, Poland's locker zone.
    await expect(country).toHaveValue('PL');
    await expect(page.locator(sel.shippingPaczkomat)).toContainText(lockerPrice(DEFAULT_LOCKER_SHIPPING.eu.pln));
    // Several countries on offer: the Poland-only note is gone.
    await expect(page.getByTestId('pl-only-note')).toHaveCount(0);

    await country.selectOption('ES');
    await expect(page.locator(sel.shippingPaczkomat)).toContainText(lockerPrice(DEFAULT_LOCKER_SHIPPING.es.pln));

    await fillContact(page);
    await expect(page.locator(sel.checkoutButton)).toBeDisabled(); // no point yet
    await page.getByTestId('choose-locker').click();
    await expect(page.locator(sel.selectedLocker)).toContainText('Locker Mercado');
    await expect(page.locator(sel.selectedLocker)).toContainText('28013 Madrid');

    const opened = await page.evaluate(() => (window as unknown as { __sppOpened: unknown[] }).__sppOpened);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ country: 'ES', carriers: 'inpost_es', language: 'en-gb' });
    expect((opened[0] as { apiKey: string }).apiKey).not.toBe('');

    let checkoutBody: Record<string, unknown> | null = null;
    await page.route('**/api/checkout', (route) => {
      checkoutBody = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_delivery_point' }),
      });
    });
    await page.locator(sel.checkoutButton).click();
    await expect(page.getByText(/Nie udało się rozpocząć płatności/i)).toBeVisible();

    expect(checkoutBody, 'checkout POST captured').not.toBeNull();
    expect(checkoutBody).toMatchObject({ delivery_method: 'paczkomat', delivery_country: 'ES', service_point_id: '10544' });
    expect(checkoutBody).not.toHaveProperty('target_point');
    // A point the server refused is dropped, so the buyer picks again.
    await expect(page.locator(sel.selectedLocker)).toHaveCount(0);
    await expect(page.locator(sel.checkoutButton)).toBeDisabled();
  });

  test('switching country drops the chosen point and remembers the choice', async ({ page, context }) => {
    await mockSendcloudPicker(page, context);
    await resetCart(page);
    await seedCeramic(page);
    await goToCart(page);

    const country = page.getByTestId('delivery-country');
    await country.selectOption('DE');
    await page.getByTestId('choose-locker').click();
    await expect(page.locator(sel.selectedLocker)).toContainText('Locker Mercado');

    await country.selectOption('ES');
    await expect(page.locator(sel.selectedLocker)).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('delivery-country')).toHaveValue('ES');
  });

  test('switching between Sendcloud countries and back to Poland keeps the cart', async ({ page, context }) => {
    await mockSendcloudPicker(page, context);
    await resetCart(page);
    await seedCeramic(page);
    await goToCart(page);

    const country = page.getByTestId('delivery-country');
    // Each switch unmounts the picker without its overlay ever opening.
    for (const next of ['ES', 'DE', 'PL', 'FR']) {
      await country.selectOption(next);
      await expect(page.locator(sel.checkoutButton)).toBeVisible();
      await expect(page.locator('[data-testid="cart-line"]')).toHaveCount(1);
    }
    // And after a point was picked (the overlay answered and removed itself).
    await page.getByTestId('choose-locker').click();
    await expect(page.locator(sel.selectedLocker)).toContainText('Locker Mercado');
    await country.selectOption('PL');
    await expect(page.locator('[data-testid="cart-line"]')).toHaveCount(1);
  });

  test('a blocked picker shows the unavailable message and keeps payment disabled', async ({ page, context }) => {
    // Script blocked and NO stub: the picker never becomes available.
    await context.route(/embed\.sendcloud\.sc/i, (route) => route.abort());
    await resetCart(page);
    await seedCeramic(page);
    await goToCart(page);

    await page.getByTestId('delivery-country').selectOption('ES');
    await fillContact(page);
    await expect(page.getByTestId('point-picker-unavailable')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(sel.checkoutButton)).toBeDisabled();
  });
});
