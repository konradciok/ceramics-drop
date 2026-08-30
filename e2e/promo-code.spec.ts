import { test, expect, type Page } from '@playwright/test';
import {
  resetCart,
  appendToCart,
  goToCart,
  fillContact,
  sel,
} from './helpers/checkout';

/**
 * Promo-code cart flow (Phase 3) — hermetic: the app's OWN endpoints
 * (/api/inventory, /api/promo/validate, /api/checkout) are intercepted,
 * Stripe is never touched, no promo rows exist in any DB.
 * @ci-safe — display + request-shape assertions only.
 */

/**
 * Seed one ceramic piece into the cart, inventory-independent: the live
 * catalogue can be (and currently is) fully sold/showroom, so a tile-based
 * seed would make the spec hostage to stock. The cart page's own prune runs
 * against /api/inventory — stub it empty and append a stable registry id.
 */
async function seedCeramic(page: Page): Promise<void> {
  await page.route('**/api/inventory', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sold: [], showroom: [] }),
    }),
  );
  await page.goto('/'); // any page, just to reach the app origin's localStorage
  await appendToCart(page, 'k01'); // stable registry id (ids never renumber)
}

async function stubValidate(page: Page, body: Record<string, unknown>): Promise<void> {
  await page.route('**/api/promo/validate', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

async function applyCode(page: Page, code: string): Promise<void> {
  await page.locator(sel.promoToggle).click();
  await page.locator(sel.promoInput).fill(code);
  await page.locator(sel.promoApply).click();
}

test.describe('promo codes @ci', () => {
  test('ceramics: applied code renders the discount row, reduces the total, and rides the checkout POST', async ({ page }) => {
    await resetCart(page);
    await seedCeramic(page);
    await goToCart(page);

    const totalBefore = await page.locator('.sum-total .v').innerText();

    await stubValidate(page, { ok: true, code: 'WELCOME10', discount: 5750 });
    await applyCode(page, 'welcome10');

    const row = page.locator(sel.promoDiscountRow);
    await expect(row).toBeVisible();
    await expect(row).toContainText('WELCOME10');
    // Server preview is minor units (5750); the row renders it negative in the
    // cart currency via the shared formatter ("-57.5 zł" — PLN prices are
    // integer-styled, so a fractional discount keeps one decimal).
    await expect(row.locator('.v')).toContainText(/-.*57[,.]5/);
    await expect(page.locator('.sum-total .v')).not.toHaveText(totalBefore);

    // Phase 6: every apply-attempt outcome fires promo_apply (site_engagement
    // mirror — see analytics-funnel.spec.ts for why the debug buffer, not raw
    // dataLayer, gives a deterministic per-event assertion).
    const debugEvents = await page.evaluate(() => {
      const raw = sessionStorage.getItem('acc_analytics_debug');
      const buf = raw ? (JSON.parse(raw) as Array<{ event?: string; engagement_type?: string }>) : [];
      return buf;
    });
    expect(debugEvents).toContainEqual(
      expect.objectContaining({ event: 'site_engagement', engagement_type: 'promo_apply' }),
    );

    // Cheapest path to an armed checkout button: studio pickup (no locker, no address).
    await page.locator('[data-testid="shipping-odbior"]').click();
    await fillContact(page);

    let checkoutBody: Record<string, unknown> | null = null;
    await page.route('**/api/checkout', (route) => {
      checkoutBody = route.request().postDataJSON() as Record<string, unknown>;
      // checkout_in_progress ends the flow without Stripe and keeps the code applied.
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'checkout_in_progress' }),
      });
    });
    await page.locator(sel.checkoutButton).click();
    // cart.checkoutError copy confirms the response was processed.
    await expect(page.getByText(/Nie udało się rozpocząć płatności/i)).toBeVisible();
    expect(checkoutBody, 'checkout POST captured').not.toBeNull();
    expect(checkoutBody!.promo_code).toBe('WELCOME10');

    // begin_checkout (fired just before the POST, from the raw dataLayer since
    // the debug mirror strips custom ecommerce fields) carries the GA4-standard
    // coupon param — proves Phase 6's client wiring, not just the request body.
    const beginCheckoutCoupon = await page.evaluate(() => {
      const dl = (window as unknown as { dataLayer?: Array<{ event?: string; ecommerce?: { coupon?: string } }> }).dataLayer ?? [];
      const entry = dl.find((e) => e.event === 'begin_checkout');
      return entry?.ecommerce?.coupon ?? null;
    });
    expect(beginCheckoutCoupon).toBe('WELCOME10');
  });

  test('error state: an expired code shows the reason copy and no discount row', async ({ page }) => {
    await resetCart(page);
    await seedCeramic(page);
    await goToCart(page);

    await stubValidate(page, { ok: false, reason: 'expired' });
    await applyCode(page, 'OLDCODE');

    const err = page.locator(sel.promoError);
    await expect(err).toBeVisible();
    // cart.promo.expired (messages/pl.json)
    await expect(err).toContainText(/stracił ważność/i);
    await expect(page.locator(sel.promoDiscountRow)).toHaveCount(0);
  });

  test('remove: clearing an applied code restores the original total', async ({ page }) => {
    await resetCart(page);
    await seedCeramic(page);
    await goToCart(page);

    const totalBefore = await page.locator('.sum-total .v').innerText();
    await stubValidate(page, { ok: true, code: 'WELCOME10', discount: 5750 });
    await applyCode(page, 'WELCOME10');
    await expect(page.locator(sel.promoDiscountRow)).toBeVisible();

    await page.locator(sel.promoRemove).click();
    await expect(page.locator(sel.promoDiscountRow)).toHaveCount(0);
    await expect(page.locator('.sum-total .v')).toHaveText(totalBefore);
  });

  test('prints track: the discount row renders in a print cart too', async ({ page }) => {
    await resetCart(page);
    // Seed a print via the configurator (fap005, 50x70 — same seam as mixed-cart.spec).
    await page.goto('/fine-art-prints/fap005');
    await page.getByTestId('opt-size-50x70').click();
    await page.getByTestId('print-add').click();
    await expect(page.locator('[data-cart-count]')).toHaveText('1');
    await goToCart(page);

    await stubValidate(page, { ok: true, code: 'ART10', discount: 1000 });
    await applyCode(page, 'art10');

    const row = page.locator(sel.promoDiscountRow);
    await expect(row).toBeVisible();
    await expect(row).toContainText('ART10');
  });

  test.describe('mobile 390px', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('promo entry and discount row stay usable at phone width', async ({ page }) => {
      await resetCart(page);
      await seedCeramic(page);
      await goToCart(page);

      await stubValidate(page, { ok: true, code: 'WELCOME10', discount: 5750 });
      await page.locator(sel.promoToggle).scrollIntoViewIfNeeded();
      await applyCode(page, 'WELCOME10');
      await expect(page.locator(sel.promoDiscountRow)).toBeVisible();
      // No horizontal overflow introduced by the promo form/row.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
