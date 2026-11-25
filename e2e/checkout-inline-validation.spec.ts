import { test, expect, type Page } from '@playwright/test';
import {
  resetCart,
  appendToCart,
  goToCart,
  dismissConsent,
  fillContact,
  mockGeowidget,
  mockLockerSelection,
  expectCheckoutBlocked,
  sel,
} from './helpers/checkout';

/**
 * Inline validation of the cart's delivery form — hermetic: one ceramic in the
 * cart independent of live stock, the InPost Geowidget stubbed, /api/checkout
 * intercepted. The pay button stays enabled; a tap on an incomplete form shows
 * the errors and focuses the first one instead of doing nothing.
 * @ci-safe — display + request-shape assertions only.
 */

const cart = (page: Page) => page.locator('#cart-root');
const input = (page: Page, name: string) => cart(page).locator(`input[name="${name}"]`);
const fieldError = (page: Page, field: string) => page.getByTestId(`field-error-${field}`);

/**
 * `fields` of every checkout_validation_error push. Read from dataLayer itself:
 * the acc_analytics_debug mirror keeps only event names, not their params.
 */
const engagementEvents = (page: Page) =>
  page.evaluate(() => {
    const layer = ((window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []) as Array<{
      engagement_type?: string;
      fields?: string;
    }>;
    return layer.filter((e) => e?.engagement_type === 'checkout_validation_error').map((e) => e.fields);
  });

async function openPolishCart(page: Page): Promise<void> {
  await page.route('**/api/inventory', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sold: [], showroom: [], available: ['k01'], activeDrops: [] }),
    }),
  );
  await resetCart(page);
  await page.goto('/');
  await appendToCart(page, 'k01');
  await goToCart(page);
  await dismissConsent(page);
  // The Geowidget is Poland's picker; the cart preselects by CF-IPCountry.
  const country = page.getByTestId('delivery-country');
  if ((await country.count()) > 0 && (await country.inputValue()) !== 'PL') await country.selectOption('PL');
}

test.describe('delivery form inline validation @ci', () => {
  test.beforeEach(async ({ page, context }) => {
    await mockGeowidget(page, context);
    await openPolishCart(page);
  });

  test('an empty form shows every missing field, focuses the first and sends nothing', async ({ page }) => {
    // No error before the buyer tries to pay.
    await expect(cart(page).locator('.field-error')).toHaveCount(0);
    await expect(page.locator(sel.checkoutButton)).toBeEnabled();

    await expectCheckoutBlocked(page, 'firstName');
    for (const field of ['lastName', 'email', 'phone', 'point']) {
      await expect(fieldError(page, field)).toBeVisible();
    }
    await expect(input(page, 'firstName')).toBeFocused();
    await expect(input(page, 'firstName')).toHaveAttribute('aria-invalid', 'true');
    await expect(input(page, 'firstName')).toHaveAttribute('aria-describedby', 'delivery-error-firstName');
    await expect.poll(() => engagementEvents(page)).toEqual(['firstName,lastName,email,phone,point']);

    // Errors track the input live once shown.
    await input(page, 'firstName').fill('Anna');
    await expect(fieldError(page, 'firstName')).toHaveCount(0);
    await expect(input(page, 'firstName')).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('a mistyped email is flagged on leaving the field, and Enter moves to the next field', async ({ page }) => {
    await input(page, 'firstName').fill('Anna');
    await input(page, 'firstName').press('Enter');
    await expect(input(page, 'lastName')).toBeFocused();
    // Moving on with Enter is not a submit: nothing is flagged yet.
    await expect(cart(page).locator('.field-error')).toHaveCount(0);

    // Leaving an empty field on the way down is not flagged either.
    await input(page, 'lastName').press('Tab');
    await expect(fieldError(page, 'lastName')).toHaveCount(0);

    await input(page, 'email').fill('anna@example');
    await input(page, 'email').blur();
    await expect(fieldError(page, 'email')).toContainText('np. imie@przyklad.pl');
    await input(page, 'email').fill('anna@example.com');
    await expect(fieldError(page, 'email')).toHaveCount(0);
  });

  test('a complete form posts the delivery details', async ({ page }) => {
    await fillContact(page);
    await page.locator('[data-testid="choose-locker"]').click();
    await mockLockerSelection(page);

    let checkoutBody: Record<string, unknown> | null = null;
    await page.route('**/api/checkout', (route) => {
      checkoutBody = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'stripe_failed' }) });
    });
    // Enter in the last field submits the form like the pay button does.
    await input(page, 'phone').press('Enter');
    await expect(page.getByText(/Nie udało się rozpocząć płatności/i)).toBeVisible();

    expect(checkoutBody, 'checkout POST captured').not.toBeNull();
    expect(checkoutBody).toMatchObject({ delivery_method: 'paczkomat', target_point: 'WAW20A' });
    await expect(cart(page).locator('.field-error')).toHaveCount(0);
    expect(await engagementEvents(page)).toEqual([]);
  });
});
