import { test, expect } from '@playwright/test';

/**
 * Customer accounts — dark-launch surface (@ci, hermetic).
 *
 * The hermetic webServer never sets SUPABASE_PUBLISHABLE_KEY, so these specs
 * pin the FAIL-CLOSED contract: /konto renders its deterministic
 * "unavailable" state, the order-detail page redirects rather than probing
 * ids, the nav entry exists, and every /api/auth/* route is a 404. This is
 * the regression gate that the storefront ships unchanged while accounts
 * stay dark (plan §10 step 3).
 */
test.describe('customer accounts (dark) @ci', () => {
  test('/konto renders the deterministic unavailable state', async ({ page }) => {
    await page.goto('/konto');
    await expect(page.getByTestId('konto-unavailable')).toBeVisible();
    // Polish copy (default locale) — proves the account namespace is wired.
    await expect(page.getByTestId('konto-unavailable')).toContainText('niedostępne');
  });

  test('locale-prefixed /en/konto serves the same state', async ({ page }) => {
    await page.goto('/en/konto');
    await expect(page.getByTestId('konto-unavailable')).toBeVisible();
    // Assert the negated wording — a bare "available" substring would also
    // match copy that wrongly claimed accounts ARE available.
    await expect(page.getByTestId('konto-unavailable')).toContainText("aren't available");
  });

  test('order detail never renders for anonymous visitors — redirects to /konto', async ({ page }) => {
    await page.goto('/konto/zamowienia/9a6f0f1e-1111-2222-3333-444455556666');
    await expect(page).toHaveURL(/\/konto\/?$/);
    await expect(page.getByTestId('konto-unavailable')).toBeVisible();
  });

  test('header exposes the static Konto entry and it navigates', async ({ page }) => {
    await page.goto('/');
    const kontoLink = page.getByTestId('nav-konto');
    await expect(kontoLink).toBeVisible();
    await expect(kontoLink).toHaveAttribute('aria-label', 'Konto');
    await kontoLink.click();
    await expect(page).toHaveURL(/\/konto\/?$/);
  });

  test('auth API routes are fail-closed 404 while dark', async ({ request }) => {
    const login = await request.post('/api/auth/login', { form: { provider: 'google' } });
    expect(login.status()).toBe(404);

    const callback = await request.get('/api/auth/callback?code=x');
    expect(callback.status()).toBe(404);

    const signout = await request.post('/api/auth/signout');
    expect(signout.status()).toBe(404);
  });
});
