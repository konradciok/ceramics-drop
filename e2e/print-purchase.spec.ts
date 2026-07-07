import { test, expect } from '@playwright/test';
import { resetCart, goToCart, fillContact, fillStripeCard, sel } from './helpers/checkout';

/**
 * Print purchase happy path (Finding 11) — configurator → kurier-only cart →
 * EU country → real Stripe test payment → return-page success.
 *
 * DESTRUCTIVE: completes a real Stripe payment; the webhook then enqueues a
 * REAL Prodigi order for fulfilment (sandbox or LIVE depending on the target
 * host's PRODIGI_ENV — live means real production costs). Run only against a
 * preview wired to PRODIGI_ENV=sandbox, with E2E_DESTRUCTIVE=1:
 *
 *   PLAYWRIGHT_BASE_URL=<preview> E2E_DESTRUCTIVE=1 npx playwright test e2e/print-purchase.spec.ts
 */

const SUCCESS_CARD = '4242424242424242';
const BUYER_EMAIL = 'e2e+playwright-print@example.com';

test.describe('print purchase @checkout-edge @destructive', () => {
  test.describe.configure({ mode: 'serial' });

  test('cart is courier-only for prints: no paczkomat, no odbiór, no Geowidget, country selectable', async ({ page }) => {
    await resetCart(page);
    await page.goto('/fine-art-prints/fap01');
    await page.getByTestId('opt-size-50x70').click();
    await page.getByTestId('opt-framed-true').click();
    await page.getByTestId('opt-colour-black').click();
    await page.getByTestId('print-add').click();
    await expect(page.locator('[data-cart-count]')).toHaveText('1');

    await goToCart(page);

    // Prodigi ships prints by courier only — the InPost options must be gone.
    await expect(page.locator('[data-testid="shipping-kurier"]')).toBeVisible();
    await expect(page.locator(sel.shippingPaczkomat)).toHaveCount(0);
    await expect(page.locator('[data-testid="shipping-odbior"]')).toHaveCount(0);
    await expect(page.locator('inpost-geowidget')).toHaveCount(0);

    // Print copy on the courier option (not the InPost courier copy).
    await expect(page.getByText('Dostawa kurierem')).toBeVisible();

    // Country is choosable (EU+UK); the ceramic PL-only note must NOT show.
    await expect(page.getByTestId('country-select')).toBeVisible();
    await expect(page.getByTestId('pl-only-note')).toHaveCount(0);
  });

  test('pays for a print to a German address and lands on the success page', async ({ page }) => {
    await resetCart(page);
    await page.goto('/fine-art-prints/fap01');
    await page.getByTestId('opt-size-50x70').click();
    await page.getByTestId('opt-framed-true').click();
    await page.getByTestId('opt-colour-black').click();
    await page.getByTestId('print-add').click();

    await goToCart(page);
    await page.getByTestId('country-select').selectOption('DE');
    await fillContact(page, BUYER_EMAIL);
    await page.getByLabel('Ulica').fill('Hauptstraße');
    await page.getByLabel('Nr', { exact: true }).fill('1');
    await page.getByLabel('Kod pocztowy').fill('10115');
    await page.getByLabel('Miasto').fill('Berlin');

    await page.locator(sel.checkoutButton).click();

    // Stripe PaymentElement mounts after POST /api/checkout succeeds.
    await fillStripeCard(page, SUCCESS_CARD);
    await page.locator(sel.paymentSubmit).click();

    await expect(page.locator(sel.checkoutSuccess)).toBeVisible({ timeout: 60_000 });
  });
});
