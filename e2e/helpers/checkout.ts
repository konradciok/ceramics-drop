import { type Page, type BrowserContext, expect } from '@playwright/test';

// Shared helpers for the failure-path checkout specs.
// Selectors are app-owned data-testids (docs/e2e-playwright-purchase-flow.md →
// "App-owned selectors"), rendered by ProductTile/CartView/CheckoutForm/return page.

export const CART_KEY = 'acc_cart_v1';

export const sel = {
  productTile: '[data-testid="product-tile"]',
  addToCart: '[data-testid="add-to-cart"]',
  cartLine: '[data-testid="cart-line"]',
  shippingPaczkomat: '[data-testid="shipping-paczkomat"]',
  selectedLocker: '[data-testid="selected-locker"]',
  checkoutButton: '[data-testid="checkout-button"]',
  paymentSubmit: '[data-testid="payment-submit"]',
  checkoutSuccess: '[data-testid="checkout-success"]',
  printTile: '[data-testid="print-tile"]',
  printConfigurator: '[data-testid="print-configurator"]',
  printPrice: '[data-testid="print-price"]',
  printAdd: '[data-testid="print-add"]',
} as const;

/**
 * Clear the Zustand-persisted cart before the app boots. Never hand-write a persist blob.
 * Init scripts re-run on EVERY navigation, so guard with a sessionStorage marker —
 * otherwise each page.goto() would wipe the items added on the previous page.
 */
export async function resetCart(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    try {
      if (!sessionStorage.getItem('__e2e_cart_reset')) {
        sessionStorage.setItem('__e2e_cart_reset', '1');
        localStorage.removeItem(key);
      }
    } catch { /* ignore */ }
  }, CART_KEY);
}

export interface PickedProduct { id: string | null; category: string; price: number; }

/** Add the first unsold tile from a category page and record its metadata. */
export async function addFirstUnsoldFromCategory(page: Page, category: string): Promise<PickedProduct> {
  await page.goto(`/${category}`);
  const tile = page.locator(`${sel.productTile}:not([data-sold="true"])`).first();
  await expect(tile, `no unsold tile in category ${category}`).toBeVisible();
  const id = await tile.getAttribute('data-product-id');
  const price = Number(await tile.getAttribute('data-price'));
  await tile.locator(sel.addToCart).click();
  return { id, category, price };
}

export async function goToCart(page: Page): Promise<void> {
  await page.goto('/koszyk');
}

/**
 * Configure a fine-art print on its PDP (size/paper/frame) and add it to the cart.
 * Returns the composite cart token so callers can assert against it.
 */
export async function addPrintVariant(
  page: Page,
  designId: string,
  v: { size: string; paper: string; frame: string },
): Promise<string> {
  await page.goto(`/fine-art-prints/${designId}`);
  await expect(page.locator(sel.printConfigurator)).toBeVisible();
  await page.locator(`[data-testid="opt-size-${v.size}"]`).click();
  await page.locator(`[data-testid="opt-paper-${v.paper}"]`).click();
  await page.locator(`[data-testid="opt-frame-${v.frame}"]`).click();
  await page.locator(sel.printAdd).click();
  return `print:${designId}:${v.size}:${v.paper}:${v.frame}`;
}

export async function selectPaczkomat(page: Page): Promise<void> {
  await page.locator(sel.shippingPaczkomat).click();
}

/**
 * Fill the receiver contact fields (CartView gates the checkout button on
 * firstName + lastName + valid email + phone for paczkomat/kurier).
 * Targets the app's autoComplete attributes — stable and app-owned.
 */
export async function fillContact(page: Page, email = 'e2e+playwright@example.com'): Promise<void> {
  await page.locator('input[autocomplete="given-name"]').fill('Test');
  await page.locator('input[autocomplete="family-name"]').fill('Playwright');
  await page.locator('input[autocomplete="email"]').fill(email);
  const phone = page.locator('input[autocomplete="tel"]');
  if (await phone.isVisible()) await phone.fill('600100200');
}

/**
 * Deterministic Geowidget seam for @ci specs: block the third-party assets and
 * pre-register a stub <inpost-geowidget> element. GeowidgetPicker awaits
 * customElements.whenDefined('inpost-geowidget') before mounting and attaching
 * its 'onpoint' listener, so the stub resolves that instantly with zero network.
 * Requires NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN baked into the build (the picker
 * renders the unavailable fallback when the token is missing).
 * Call BEFORE the first page.goto().
 */
export async function mockGeowidget(page: Page, context: BrowserContext): Promise<void> {
  await blockGeowidget(context);
  await page.addInitScript(() => {
    if (!customElements.get('inpost-geowidget')) {
      customElements.define('inpost-geowidget', class extends HTMLElement {});
    }
  });
}

/**
 * CI-safe locker selection: simulate the InPost Geowidget v5 selection event.
 *
 * InPost Geowidget v5 dispatches a CustomEvent on `document` whose name is the
 * value of the element's `onpoint` attribute (GeowidgetPicker sets this to
 * 'inpost.point.select'). The payload arrives on `event.details` (plural).
 * We use `detail` here because CustomEvent init only supports `detail`; the
 * GeowidgetPicker handler falls back to `event.detail` automatically.
 *
 * The default MUST be a real, Operating ShipX point: on a completed payment the
 * prod webhook creates a real InPost shipment against it, and a fabricated code
 * fails ShipX validation (400 validation_failed) leaving the order shipment-less.
 * WAW20A = Łopuszańska 38B, 02-220 Warszawa — verified via
 * GET https://api-shipx-pl.easypack24.net/v1/points/WAW20A.
 */
export async function mockLockerSelection(page: Page, lockerCode = 'WAW20A'): Promise<void> {
  // Fast-fail with a clear blocker when the picker rendered its unavailable
  // fallback instead of the widget (token missing at build time).
  const widget = page.locator('inpost-geowidget');
  const unavailable = page.locator('.geowidget-msg');
  await widget.or(unavailable).first().waitFor({ state: 'attached' });
  if (await unavailable.isVisible().catch(() => false)) {
    throw new Error(
      'ENVIRONMENT BLOCKER: Geowidget fallback rendered — NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN ' +
        'must be set at build time (any non-empty value satisfies the mock seam).',
    );
  }
  // Wait for the element to mount so GeowidgetPicker's document listener is registered.
  await widget.waitFor({ state: 'attached' });
  await page.evaluate((code) => {
    // Mirror InPost v5: dispatch on document with the POINT_EVENT name, not on the element.
    const detail = { name: code, address: { line1: 'Łopuszańska 38B, 02-220 Warszawa' } };
    document.dispatchEvent(new CustomEvent('inpost.point.select', { detail }));
  }, lockerCode);
  await expect(page.locator(sel.selectedLocker)).toContainText(lockerCode);
}

/**
 * Fill the Stripe Payment Element card fields. The element renders inside our
 * .pay-form, so anchor the frameLocator there. Placeholders are locale-aware:
 * PL expiry shows "MM / RR".
 */
export async function fillStripeCard(page: Page, number: string): Promise<void> {
  const frame = page.frameLocator('.pay-form iframe').first();
  // If the Payment Element shows method tabs (card / BLIK / P24), pick card first.
  const cardTab = frame.locator('button:has-text("Karta"), button:has-text("Card")').first();
  if (await cardTab.isVisible().catch(() => false)) await cardTab.click();
  await frame.getByPlaceholder(/1234 1234 1234 1234|card number/i).fill(number);
  await frame.getByPlaceholder(/MM ?\/ ?(YY|RR)/i).fill('12 / 34');
  await frame.getByPlaceholder(/CVC/i).fill('123');
}

/** Block the InPost Geowidget assets (production + sandbox hosts) — simulates missing token / outage. */
export async function blockGeowidget(context: BrowserContext): Promise<void> {
  await context.route(/geowidget\.inpost\.pl|easypack24\.net/i, (route) => route.abort());
}
