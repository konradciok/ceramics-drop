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
 * The cart below the two-column breakpoint (phones): the order summary folds
 * to one bar above the delivery form, and a fixed pay bar stands in for the
 * pay button while that is below the fold. Hermetic: one ceramic independent
 * of live stock, the Geowidget stubbed.
 * @ci-safe — layout + request-shape assertions only.
 */

const PIECE = 'k01';

async function openCartOnPhone(page: Page, width = 390): Promise<void> {
  await page.setViewportSize({ width, height: 664 });
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

const paybar = (page: Page) => page.getByTestId('cart-paybar');

test.describe('cart on a phone @ci', () => {
  test.beforeEach(async ({ page, context }) => {
    await mockGeowidget(page, context);
  });

  test('the summary folds to one bar with the total, and opens on tap', async ({ page }) => {
    await openCartOnPhone(page);
    const toggle = page.getByTestId('summary-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText(await page.locator('.sum-total .v').textContent() ?? '');
    await expect(page.locator('#summary-body')).toBeHidden();

    // It sits between the pieces and the delivery form.
    const listBottom = await page.locator('.cart-list').evaluate((el) => el.getBoundingClientRect().bottom);
    const toggleTop = await toggle.evaluate((el) => el.getBoundingClientRect().top);
    const formTop = await page.locator('#delivery-form').evaluate((el) => el.getBoundingClientRect().top);
    expect(toggleTop).toBeGreaterThan(listBottom);
    expect(formTop).toBeGreaterThan(toggleTop);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.sum-total')).toBeVisible();
    await expect(page.locator(sel.promoToggle)).toBeVisible();
    // The pieces are listed above already — no second list in the summary.
    await expect(page.locator('.sum-items')).toBeHidden();
  });

  test('a pay bar stands in for the pay button while it is below the fold', async ({ page }) => {
    await openCartOnPhone(page);
    await expect(paybar(page)).toHaveClass(/\bshow\b/);
    await expect(page.getByTestId('checkout-button-paybar')).toBeVisible();

    // Tapping it submits the delivery form: the inline errors, nothing sent.
    let posted = false;
    page.on('request', (r) => {
      if (r.url().includes('/api/checkout')) posted = true;
    });
    await page.getByTestId('checkout-button-paybar').click();
    await expect(page.getByTestId('field-error-firstName')).toBeVisible();
    await expect(page.locator('#cart-root input[name="firstName"]')).toBeFocused();
    expect(posted).toBe(false);

    // Once the in-flow button is on screen the bar leaves (and is inert).
    await page.locator(sel.checkoutButton).scrollIntoViewIfNeeded();
    await expect(paybar(page)).not.toHaveClass(/\bshow\b/);
    expect(await paybar(page).evaluate((el) => (el as HTMLElement).inert)).toBe(true);
  });

  test('a scroll jump straight past the pay button still updates the bar', async ({ page }) => {
    await openCartOnPhone(page);
    await expect(paybar(page)).toHaveClass(/\bshow\b/);
    // Top → page end in one jump: the button is never on screen in between.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(paybar(page)).not.toHaveClass(/\bshow\b/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(paybar(page)).toHaveClass(/\bshow\b/);
  });

  test('opening the summary that pushes the button below the fold shows the bar', async ({ page }) => {
    await openCartOnPhone(page);
    // A viewport just tall enough for the in-flow button: no bar at offset 0.
    const ctaBottom = await page
      .locator(sel.checkoutButton)
      .evaluate((el) => Math.ceil(el.getBoundingClientRect().bottom + window.scrollY));
    await page.setViewportSize({ width: 390, height: ctaBottom + 24 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(paybar(page)).not.toHaveClass(/\bshow\b/);

    // Opening the summary above it moves the button down with no scroll event.
    await page.getByTestId('summary-toggle').click();
    await expect(paybar(page)).toHaveClass(/\bshow\b/);
  });

  test('a valid submit from the pay bar brings the outcome on screen', async ({ page }) => {
    await openCartOnPhone(page);
    await fillContact(page);
    await page.locator('[data-testid="choose-locker"]').click();
    await mockLockerSelection(page);
    await page.route('**/api/checkout', (route) =>
      route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'stripe_failed' }) }),
    );

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(paybar(page)).toHaveClass(/\bshow\b/);
    await page.getByTestId('checkout-button-paybar').click();

    const error = page.getByText(/Nie udało się rozpocząć płatności/i);
    await expect(error).toBeVisible();
    await expect(error).toBeInViewport();
    await expect(page.locator('.cart-cta')).toBeFocused();
  });

  test('no horizontal scroll at 320px', async ({ page }) => {
    await openCartOnPhone(page, 320);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBe(0);
  });

  test('desktop keeps the open summary and no pay bar', async ({ page }) => {
    await openCartOnPhone(page, 1280);
    await expect(page.getByTestId('summary-toggle')).toBeHidden();
    await expect(page.locator('.summary-h')).toBeVisible();
    await expect(page.locator('.sum-items')).toBeVisible();
    await expect(paybar(page)).toBeHidden();
  });
});
