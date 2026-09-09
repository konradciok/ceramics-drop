import { test, expect, type Page } from '@playwright/test';
import { resetCart, appendToCart, goToCart, fillContact, sel } from './helpers/checkout';

async function prepare(page: Page) {
  // Every mutating endpoint is intercepted. No Stripe or live inventory writes.
  await page.route('**/api/checkout', route => route.fulfill({ status: 503, json: { error: 'gift_card_unavailable' } }));
  await page.route('**/api/inventory', route => route.fulfill({ json: { sold: [], showroom: [], available: ['k01'] } }));
  await page.route('**/api/gift-cards/balance', route => route.fulfill({ json: { code: 'GIFT-E2E', currency: 'pln', available: 100000 } }));
  await resetCart(page);
  await page.goto('/'); await appendToCart(page, 'k01'); await goToCart(page);
  await page.getByText('Mam kartę podarunkową', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Kod karty podarunkowej', exact: true }).fill('GIFT-E2E');
  await page.getByRole('button', { name: 'Użyj karty', exact: true }).click();
  await expect(page.getByText(/Dostępne saldo:/)).toBeVisible();
  await page.locator('[data-testid="shipping-odbior"]').click();
  await fillContact(page);
}

test.describe('gift card balance @ci', () => {
  test('a full balance payment uses its confirmation URL and clears purchased items without Stripe', async ({ page }) => {
    await prepare(page);
    let submitted: Record<string, unknown> | undefined;
    await page.route('**/api/checkout', route => {
      submitted = route.request().postDataJSON();
      return route.fulfill({ json: { status: 'paid', confirmation_url: '/koszyk/potwierdzenie?order=e2e&receipt=test', gift_card_amount: 57500, cash_amount: 0 } });
    });
    await page.route('**/koszyk/potwierdzenie?*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Potwierdzenie testowe</h1>' }));
    await page.locator(sel.checkoutButton).click();
    await expect(page).toHaveURL(/\/koszyk\/potwierdzenie\?/);
    expect(submitted?.gift_card_code).toBe('GIFT-E2E');
    expect(submitted?.promo_code).toBeUndefined();
    const cart = await page.evaluate(() => JSON.parse(localStorage.getItem('acc_cart_v1') ?? '{}'));
    expect(cart.state.ids).toEqual([]);
  });

  test('an uncertain payment retains its attempt id and never leaks the card code to analytics', async ({ page }) => {
    await prepare(page);
    const ids: string[] = [];
    await page.route('**/api/checkout', route => {
      ids.push(route.request().postDataJSON().attemptId);
      return route.fulfill({ status: 503, json: { error: 'gift_card_unavailable' } });
    });
    await page.locator(sel.checkoutButton).click();
    await expect(page.locator('.pay-error')).toContainText('saldo');
    await page.locator(sel.checkoutButton).click();
    await expect.poll(() => ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    const telemetry = await page.evaluate(() => JSON.stringify((window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []));
    expect(telemetry).not.toContain('GIFT-E2E');
    expect(page.url()).not.toContain('GIFT-E2E');
  });
});
