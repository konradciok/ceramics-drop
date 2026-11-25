import { test, expect, type Page } from '@playwright/test';
import {
  resetCart,
  appendToCart,
  goToCart,
  dismissConsent,
  fillContact,
  mockGeowidget,
  mockLockerSelection,
  sel,
} from './helpers/checkout';

/**
 * The step after a successful /api/checkout: the delivery form makes way for
 * a read-only recap, the payment heading takes focus, and the pay button names
 * the amount. Hermetic: one ceramic independent of live stock, the Geowidget
 * stubbed, /api/checkout intercepted and Stripe.js blocked — the Payment
 * Element itself never loads, only the app's own UI around it is asserted.
 * @ci-safe — display assertions only.
 */

const PIECE = 'k01';

async function reachPaymentStep(page: Page, { delayMs = 0 }: { delayMs?: number } = {}): Promise<void> {
  await page.context().route(/js\.stripe\.com/i, (route) => route.abort());
  await page.route('**/api/inventory', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sold: [], showroom: [], available: [PIECE], activeDrops: [] }),
    }),
  );
  await page.route('**/api/checkout', async (route) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ client_secret: 'pi_e2e_secret_e2e' }) });
  });
  await resetCart(page);
  await page.goto('/');
  await appendToCart(page, PIECE);
  await goToCart(page);
  await dismissConsent(page);
  const country = page.getByTestId('delivery-country');
  if ((await country.count()) > 0 && (await country.inputValue()) !== 'PL') await country.selectOption('PL');
  await fillContact(page, 'anna@example.com');
  await page.locator('[data-testid="choose-locker"]').click();
  await mockLockerSelection(page);
  await page.locator(sel.checkoutButton).click();
}

test.describe('payment step @ci', () => {
  test.beforeEach(async ({ page, context }) => {
    await mockGeowidget(page, context);
  });

  test('a read-only delivery recap replaces the form and the payment heading takes focus', async ({ page }) => {
    await reachPaymentStep(page);

    const recap = page.getByTestId('delivery-recap');
    await expect(recap).toBeVisible();
    await expect(recap).toContainText('WAW20A');
    await expect(recap).toContainText('Łopuszańska 38B');
    await expect(recap).toContainText('anna@example.com');
    await expect(page.locator('#delivery-form')).toHaveCount(0);

    await expect(page.getByTestId('payment-heading')).toBeFocused();
    await expect(page.getByTestId('payment-heading')).toBeInViewport();
  });

  test('delivery and contact are locked while the checkout request runs', async ({ page }) => {
    await reachPaymentStep(page, { delayMs: 1500 });
    // In flight: the point and the contact the request carries cannot change.
    await expect(page.getByTestId('change-locker')).toBeDisabled();
    await expect(page.locator('#cart-root input[name="email"]')).toBeDisabled();
    const recap = page.getByTestId('delivery-recap');
    await expect(recap).toContainText('WAW20A');
    await expect(recap).toContainText('anna@example.com');
  });

  test('the pay button names the amount it charges', async ({ page }) => {
    await reachPaymentStep(page);
    const total = (await page.locator('.sum-total .v').textContent())?.trim() ?? '';
    expect(total).not.toBe('');
    await expect(page.locator(sel.paymentSubmit)).toHaveText(`Zapłać ${total}`);
  });

  test('the chosen InPost locker shows its address before payment', async ({ page }) => {
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
    const country = page.getByTestId('delivery-country');
    if ((await country.count()) > 0 && (await country.inputValue()) !== 'PL') await country.selectOption('PL');
    await page.locator('[data-testid="choose-locker"]').click();
    await mockLockerSelection(page);
    await expect(page.locator(sel.selectedLocker)).toContainText('Łopuszańska 38B');
  });
});
