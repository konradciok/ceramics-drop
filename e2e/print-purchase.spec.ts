import { test, expect } from '@playwright/test';
import { resetCart, goToCart, fillContact, fillStripeCard, sel } from './helpers/checkout';
import { PRINT_DELIVERY_DRAFT_KEY } from '../src/lib/print-delivery-key';

/**
 * Print purchase (Finding 11).
 *
 * `@ci` block — courier-only cart UI; no Stripe, no Prodigi.
 *
 * `@destructive` block — configurator → kurier-only cart → EU country → real
 * Stripe test payment → return-page success → polls the fail-closed
 * /api/debug/fulfilment-status route to assert the order's fulfilment actually
 * advanced (Stripe→webhook→queue→Prodigi), so a pipeline regression fails the
 * spec instead of passing on a bare success-page assertion. The webhook
 * enqueues a REAL Prodigi order (sandbox or LIVE per the host's PRODIGI_ENV).
 * Run only against a preview wired to PRODIGI_ENV=sandbox:
 *
 *   PLAYWRIGHT_BASE_URL=<preview> E2E_DESTRUCTIVE=1 E2E_PRODIGI_SANDBOX=1 \
 *     E2E_FULFILMENT_DEBUG_TOKEN=<preview's FULFILMENT_DEBUG_TOKEN> \
 *     npx playwright test e2e/print-purchase.spec.ts --grep @destructive
 */

const SUCCESS_CARD = '4242424242424242';
const BUYER_EMAIL = 'e2e+playwright-print@example.com';

test.describe('print cart UI @ci', () => {
  test('cart is courier-only for prints: no paczkomat, no odbiór, no Geowidget, country selectable', async ({ page }) => {
    await resetCart(page);
    await page.goto('/fine-art-prints/fap005');
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
    await expect(page.getByTestId('country-select')).toHaveValue('PL');
    await expect(page.getByTestId('pl-only-note')).toHaveCount(0);
    await expect(page.locator('input[name="contact.first_name"]')).toHaveAttribute('autocomplete', 'section-print shipping given-name');
    await expect(page.locator('input[name="address.line1"]')).toHaveAttribute('autocomplete', 'section-print shipping address-line1');
    await expect(page.locator('input[name="address.line2"]')).toHaveAttribute('autocomplete', 'section-print shipping address-line2');
  });

  test('validates, restores a session draft, and reprices immediately when country changes', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'CF-IPCountry': 'DE' });
    await resetCart(page);
    await page.goto('/fine-art-prints/fap005');
    await page.getByTestId('opt-size-50x70').click();
    await page.getByTestId('opt-framed-true').click();
    await page.getByTestId('opt-colour-black').click();
    await page.getByTestId('print-add').click();
    await goToCart(page);

    await expect(page.getByTestId('country-select')).toHaveValue('DE');
    await page.locator(sel.checkoutButton).click();
    const firstName = page.locator('input[name="contact.first_name"]');
    await expect(firstName).toBeFocused();
    await expect(page.getByText('To pole jest wymagane.').first()).toBeVisible();

    await firstName.fill('Test');
    await page.locator('input[name="contact.last_name"]').fill('Playwright');
    await page.locator('input[name="contact.email"]').fill('print@example.com');
    await page.locator('input[name="contact.phone"]').fill('030 123456');
    await page.locator('input[name="address.line1"]').fill('Hauptstraße 1');
    await page.locator('input[name="address.line2"]').fill('Hinterhaus');
    await page.locator('input[name="address.post_code"]').fill('10115');
    await page.locator('input[name="address.city"]').fill('Berlin');

    const deliveryRow = page.locator('.summary .sum-row').filter({ hasText: 'Dostawa' });
    const dePrice = await deliveryRow.locator('.v').textContent();
    expect(dePrice).toBeTruthy();
    await page.getByTestId('country-select').selectOption('GB');
    await expect(deliveryRow.locator('.v')).not.toHaveText(dePrice!);

    const storedDraft = await page.evaluate((draftKey) => ({
      localDraft: localStorage.getItem(draftKey),
      localValues: Object.values(localStorage),
      sessionDraft: sessionStorage.getItem(draftKey),
    }), PRINT_DELIVERY_DRAFT_KEY);
    expect(storedDraft.localDraft).toBeNull();
    expect(storedDraft.localValues).not.toContainEqual(expect.stringContaining('Hauptstraße 1'));
    expect(storedDraft.sessionDraft).toContain('Hauptstraße 1');

    await page.reload();
    await expect(page.getByTestId('country-select')).toHaveValue('GB');
    await expect(page.locator('input[name="address.line1"]')).toHaveValue('Hauptstraße 1');
    await expect(page.locator('input[name="address.line2"]')).toHaveValue('Hinterhaus');
  });
});

test.describe('print purchase @checkout-edge @destructive', () => {
  test.describe.configure({ mode: 'serial' });

  test('pays for a print to a German address and lands on the success page', async ({ page, request, baseURL }) => {
    if (/localhost|127\.0\.0\.1/.test(baseURL ?? '') && process.env.E2E_ALLOW_LOCALHOST !== '1') {
      throw new Error(
        `ENVIRONMENT BLOCKER: baseURL is ${baseURL}; set E2E_ALLOW_LOCALHOST=1 to run @destructive locally.`,
      );
    }
    if (process.env.E2E_PRODIGI_SANDBOX !== '1') {
      throw new Error(
        'ENVIRONMENT BLOCKER: set E2E_PRODIGI_SANDBOX=1 only when the target preview has PRODIGI_ENV=sandbox (live Prodigi costs real money).',
      );
    }

    await resetCart(page);
    await page.goto('/fine-art-prints/fap005');
    await page.getByTestId('opt-size-50x70').click();
    await page.getByTestId('opt-framed-true').click();
    await page.getByTestId('opt-colour-black').click();
    await page.getByTestId('print-add').click();

    await goToCart(page);
    await page.getByTestId('country-select').selectOption('DE');
    await fillContact(page, BUYER_EMAIL);
    await page.getByLabel('Ulica i numer budynku').fill('Hauptstraße 1');
    await page.getByLabel('Kod pocztowy').fill('10115');
    await page.getByLabel('Miasto').fill('Berlin');

    await page.locator(sel.checkoutButton).click();

    // Stripe PaymentElement mounts after POST /api/checkout succeeds.
    await fillStripeCard(page, SUCCESS_CARD);
    await page.locator(sel.paymentSubmit).click();

    await expect(page.locator(sel.checkoutSuccess)).toBeVisible({ timeout: 60_000 });

    // ── Fulfilment advancement (audit H-2) ──────────────────────────────────
    // The success page proves the payment, NOT that the Stripe→webhook→queue→
    // Prodigi pipeline ran. Poll the fail-closed debug route until the order's
    // fulfilment advanced (job submitted to Prodigi OR Prodigi accepted and
    // minted an order id). Generous timeout: webhook + Cloudflare Queue +
    // Prodigi sandbox round-trip can take tens of seconds.
    const returnParams = new URL(page.url()).searchParams;
    const clientSecret = returnParams.get('payment_intent_client_secret');
    expect(clientSecret, 'return URL must carry payment_intent_client_secret').toBeTruthy();
    // client_secret is `pi_<id>_secret_<secret>` — the PaymentIntent id is the prefix.
    const paymentIntentId = clientSecret!.slice(0, clientSecret!.indexOf('_secret_'));

    const debugToken = process.env.E2E_FULFILMENT_DEBUG_TOKEN;
    expect(
      debugToken,
      'set E2E_FULFILMENT_DEBUG_TOKEN (must match FULFILMENT_DEBUG_TOKEN on the target preview)',
    ).toBeTruthy();

    const ADVANCED = new Set(['fulfilment_submitted', 'in_production', 'shipped']);
    const deadline = Date.now() + 120_000;
    let lastSeen = 'no successful response yet';
    let advanced = false;
    while (Date.now() < deadline && !advanced) {
      const r = await request.get(
        `/api/debug/fulfilment-status?payment_intent=${paymentIntentId}&ts=${Date.now()}`,
        { headers: { 'x-fulfilment-debug-token': debugToken! } },
      );
      if (r.ok()) {
        const body = (await r.json()) as { fulfilmentStatus: string | null; prodigiOrderId: string | null };
        lastSeen = `fulfilmentStatus=${body.fulfilmentStatus ?? 'null'}, prodigiOrderId=${body.prodigiOrderId ?? 'null'}`;
        advanced = Boolean(body.prodigiOrderId) || ADVANCED.has(body.fulfilmentStatus ?? '');
      } else {
        lastSeen = `debug route HTTP ${r.status()}`;
      }
      if (!advanced) await page.waitForTimeout(3_000);
    }
    expect(
      advanced,
      `print fulfilment did not advance within 120s — the Stripe→webhook→queue→Prodigi path may have regressed. Last seen: ${lastSeen}`,
    ).toBe(true);
  });
});
