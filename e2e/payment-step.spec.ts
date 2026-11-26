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

async function reachPaymentStep(
  page: Page,
  { delayMs = 0, onCheckout }: { delayMs?: number; onCheckout?: (body: Record<string, unknown>) => void } = {},
): Promise<void> {
  await page.context().route(/js\.stripe\.com/i, (route) => route.abort());
  await page.route('**/api/inventory', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sold: [], showroom: [], available: [PIECE], activeDrops: [] }),
    }),
  );
  await page.route('**/api/checkout', async (route) => {
    onCheckout?.(route.request().postDataJSON() as Record<string, unknown>);
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

  test('on a phone the per-parcel note survives the hand-over from the delivery form to the summary', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reachPaymentStep(page);
    await expect(page.getByTestId('delivery-recap')).toBeVisible();
    // The delivery form — and the copy of the note under its options — is gone.
    await expect(page.getByTestId('delivery-per-parcel')).toHaveCount(0);
    // So the summary's copy, hidden on phones while the form was up, is back.
    const toggle = page.getByTestId('summary-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(page.getByTestId('summary-per-parcel')).toBeVisible();
    await expect(page.getByTestId('summary-per-parcel')).toHaveText(/całą paczkę/);
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

test.describe('editing delivery from the payment step @ci', () => {
  test.beforeEach(async ({ page, context }) => {
    await mockGeowidget(page, context);
  });

  test('"Zmień" brings the form back as it was, and the next checkout runs under the attempt that holds the pieces', async ({ page }) => {
    const checkouts: Array<Record<string, unknown>> = [];
    const edits: Array<Record<string, unknown>> = [];
    await page.route('**/api/checkout/edit', async (route) => {
      edits.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, transferred: 1 }) });
    });
    await reachPaymentStep(page, { onCheckout: (body) => checkouts.push(body) });
    await expect(page.getByTestId('delivery-recap')).toBeVisible();

    await page.getByTestId('edit-delivery').click();
    await expect(page.locator('#delivery-form')).toBeVisible();
    await expect(page.getByTestId('delivery-recap')).toHaveCount(0);
    await expect(page.locator('#cart-root input[name="email"]')).toHaveValue('anna@example.com');
    await expect(page.getByTestId('selected-locker')).toContainText('WAW20A');
    await expect(page.locator('#cart-root input[name="firstName"]')).toBeFocused();

    // The server is told which order to retire, with the secret that proves it
    // is the buyer's, and which (unsent) attempt takes over the hold.
    expect(edits).toHaveLength(1);
    expect(edits[0].orderId).toBe(checkouts[0].attemptId);
    expect(edits[0].clientSecret).toBe('pi_e2e_secret_e2e');
    expect(edits[0].nextAttemptId).not.toBe(edits[0].orderId);

    await page.getByTestId('change-locker').click();
    await mockLockerSelection(page, 'KRA010');
    await page.locator(sel.checkoutButton).click();
    await expect(page.getByTestId('delivery-recap')).toContainText('KRA010');
    expect(checkouts).toHaveLength(2);
    expect(checkouts[1].attemptId).toBe(edits[0].nextAttemptId);
    expect(checkouts[1].target_point).toBe('KRA010');

    // One checkout journey: begin_checkout is not counted twice.
    const beginCheckouts = await page.evaluate(
      () =>
        (((window as unknown as { dataLayer?: Array<{ event?: string }> }).dataLayer ?? []).filter(
          (e) => e?.event === 'begin_checkout',
        )).length,
    );
    expect(beginCheckouts).toBe(1);
  });

  test('a payment already under way keeps the payment step and says why', async ({ page }) => {
    await page.route('**/api/checkout/edit', (route) =>
      route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'payment_in_progress' }) }),
    );
    await reachPaymentStep(page);
    await page.getByTestId('edit-delivery').click();
    await expect(page.locator('.pay-error')).toContainText('Płatność jest już w toku');
    await expect(page.getByTestId('delivery-recap')).toBeVisible();
    await expect(page.locator('#delivery-form')).toHaveCount(0);
  });
});
