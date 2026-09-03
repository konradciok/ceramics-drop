import { test, expect } from '@playwright/test';

/**
 * SEO routing contract (@ci, hermetic) — P1-01/SEO-011.
 *
 * Status-code and redirect-destination coverage that didn't exist anywhere
 * before this: no unit test boots a server, and no other Playwright spec
 * asserts on page-route HTTP status or follows a redirect through to its
 * destination's rendered <head>.
 */

test.describe('SEO routing contract @ci', () => {
  test.describe('404 matrix', () => {
    // "Hidden/draft product -> 404" (the third branch of isProductPublic's
    // guard in the PDP route) is deliberately NOT re-tested here: it already
    // has full unit coverage in src/lib/products.test.ts (isProductPublic),
    // and the hermetic CATALOG_SOURCE=code build has no non-active product
    // fixture to hit — HIDDEN_CATEGORIES is empty and every registry product
    // resolves status: undefined -> active in code mode.
    const cases = [
      { label: 'wrong category (k01 is kubki, not wazony)', path: '/wazony/k01' },
      { label: 'nonexistent ceramic id', path: '/kubki/nonexistent-id-999' },
      { label: 'removed ceramic id (k15, in the REMOVED set)', path: '/kubki/k15' },
      { label: 'nonexistent print id', path: '/fine-art-prints/fap999' },
      { label: 'unmapped legacy-shaped URL stays a real 404, never bulk-redirects', path: '/products/some-fake-handle' },
    ];

    for (const { label, path } of cases) {
      test(label, async ({ request }) => {
        // maxRedirects: 0 — APIRequestContext follows redirects by default
        // (up to 20), which would mask a case that only 404s indirectly.
        const response = await request.get(path, { maxRedirects: 0 });
        expect(response.status()).toBe(404);
      });
    }

    test('404 body is noindex (Next auto-injects on notFound())', async ({ page }) => {
      const response = await page.goto('/kubki/nonexistent-id-999');
      expect(response?.status()).toBe(404);
      await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    });
  });

  test.describe('legacy redirect -> destination (P0-07/SEO-017)', () => {
    test('/pages/about-me -> 301 -> /o-studiu (200, sane metadata)', async ({ page, request }) => {
      const redirectResponse = await request.get('/pages/about-me', { maxRedirects: 0 });
      expect(redirectResponse.status()).toBe(301);
      expect(redirectResponse.headers()['location']).toBe('/o-studiu');

      const pageResponse = await page.goto('/o-studiu');
      expect(pageResponse?.status()).toBe(200);
      await expect(page).toHaveTitle(/.+/);
      await expect(page.locator('head link[rel="canonical"]')).toHaveCount(1);
    });

    test('/en/pages/contact -> 301 -> /en/kontakt', async ({ request }) => {
      const redirectResponse = await request.get('/en/pages/contact', { maxRedirects: 0 });
      expect(redirectResponse.status()).toBe(301);
      expect(redirectResponse.headers()['location']).toBe('/en/kontakt');
    });
  });
});
