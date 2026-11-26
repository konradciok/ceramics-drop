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
  promoToggle: '[data-testid="promo-toggle"]',
  promoInput: '[data-testid="promo-input"]',
  promoApply: '[data-testid="promo-apply"]',
  promoError: '[data-testid="promo-error"]',
  promoDiscountRow: '[data-testid="promo-discount-row"]',
  promoRemove: '[data-testid="promo-remove"]',
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

/** Add the first purchasable tile from a category page and record its metadata.
 *  Excludes showroom pieces too: they render without data-sold but their
 *  add-to-cart button is disabled (notForSale), so picking one hangs the click. */
export async function addFirstUnsoldFromCategory(page: Page, category: string): Promise<PickedProduct> {
  await page.goto(`/${category}`);
  const tile = page.locator(`${sel.productTile}:not([data-sold="true"]):not([data-showroom="true"])`).first();
  await expect(tile, `no unsold tile in category ${category}`).toBeVisible();
  const id = await tile.getAttribute('data-product-id');
  const price = Number(await tile.getAttribute('data-price'));
  // A click that lands before hydration is a silent no-op, so confirm the
  // piece reached the persisted cart and re-click only while it has not (the
  // check runs first on every retry, so a slow write is never double-clicked).
  const inCart = () =>
    page.evaluate(({ key, id }) => {
      const ids: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')?.state?.ids;
      return Array.isArray(ids) && ids.includes(id);
    }, { key: CART_KEY, id });
  await expect(async () => {
    if (!(await inCart())) await tile.locator(sel.addToCart).click();
    expect(await inCart(), `${id} must reach the persisted cart`).toBe(true);
  }).toPass({ timeout: 10_000 });
  return { id, category, price };
}

export async function goToCart(page: Page): Promise<void> {
  await page.goto('/koszyk');
}

/** Append a product id to the persisted cart (Zustand persist blob). */
export async function appendToCart(page: Page, productId: string): Promise<void> {
  await page.evaluate(({ key, productId }) => {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : { state: { ids: [] as string[] }, version: 0 };
    const ids: string[] = parsed.state?.ids ?? [];
    if (!ids.includes(productId)) {
      parsed.state = { ids: [...ids, productId] };
      localStorage.setItem(key, JSON.stringify(parsed));
    }
  }, { key: CART_KEY, productId });
}

/**
 * Close the cookie banner (reject — the privacy-preserving choice) when it is
 * up. It is fixed over the lower-left of the viewport, so a click target that
 * lands under it is intercepted; with the site's smooth scrolling, Playwright's
 * re-scroll retries then never see the target as stable.
 */
export async function dismissConsent(page: Page): Promise<void> {
  const reject = page.locator('[role="dialog"].consent .consent-reject');
  if (await reject.isVisible().catch(() => false)) {
    await reject.click();
    await expect(page.locator('[role="dialog"].consent')).toBeHidden();
  }
}

/**
 * The pay button stays enabled while the delivery form is incomplete; a tap
 * must show `field`'s inline error (CartView's data-testid="field-error-…")
 * and send nothing to /api/checkout.
 */
export async function expectCheckoutBlocked(page: Page, field: string): Promise<void> {
  let posted = false;
  const onRequest = (request: { url(): string }) => {
    if (request.url().includes('/api/checkout')) posted = true;
  };
  page.on('request', onRequest);
  try {
    await page.locator(sel.checkoutButton).click();
    await expect(page.getByTestId(`field-error-${field}`)).toBeVisible();
    expect(posted, 'an incomplete delivery form must not POST /api/checkout').toBe(false);
  } finally {
    page.off('request', onRequest);
  }
}

export async function selectPaczkomat(page: Page): Promise<void> {
  // The banner renders on hydration, before the cart's delivery section.
  await dismissConsent(page);
  // The Geowidget is Poland's picker. Pin the country: the cart preselects by
  // CF-IPCountry, so an edge runner whose IP resolves to a Sendcloud country
  // would otherwise get the Sendcloud picker.
  const country = page.getByTestId('delivery-country');
  if ((await country.count()) > 0 && (await country.inputValue()) !== 'PL') await country.selectOption('PL');
  const option = page.locator(sel.shippingPaczkomat);
  // The locker is the only checkout method and renders as a plain card with
  // no radio; with several methods on offer, pick it unless already picked.
  const radio = option.locator('input[type="radio"]');
  if ((await radio.count()) > 0 && !(await radio.isChecked())) await option.click();
  // The InPost map mounts only on explicit intent (collapse-behind-button UX);
  // open it so mockLockerSelection / real-map driving find the widget.
  await page.locator('[data-testid="choose-locker"]').click();
}

/**
 * Pick the InPost locker through a mocked Geowidget selection — the hermetic
 * path to an armed checkout button now that courier delivery and studio pickup
 * are switched off. Needs mockGeowidget(page, context) BEFORE the first
 * page.goto(). Pair with fillContact (lockers need a phone).
 */
export async function selectMockedLocker(page: Page): Promise<void> {
  await selectPaczkomat(page);
  await mockLockerSelection(page);
}

/**
 * Fill the receiver contact fields (CartView's delivery form requires
 * firstName + lastName + valid email + a phone for paczkomat/kurier).
 * Targets the app's autoComplete attributes — stable and app-owned — scoped to
 * the checkout container: the footer newsletter form (FooterNewsletterForm)
 * renders an autocomplete="email" input on every page, so page-wide
 * autocomplete selectors are no longer unique on /koszyk.
 */
export async function fillContact(page: Page, email = 'e2e+playwright@example.com'): Promise<void> {
  const checkout = page.locator('#cart-root');
  await checkout.locator('input[autocomplete="given-name"], input[autocomplete$=" given-name"]').fill('Test');
  await checkout.locator('input[autocomplete="family-name"], input[autocomplete$=" family-name"]').fill('Playwright');
  await checkout.locator('input[autocomplete="email"], input[autocomplete$=" email"]').fill(email);
  const phone = checkout.locator('input[autocomplete="tel"], input[autocomplete$=" tel"]');
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
