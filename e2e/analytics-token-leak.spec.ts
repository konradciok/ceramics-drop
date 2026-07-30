import { test, expect } from '@playwright/test';

// N-1 regression guard (docs/audits/analytics-architecture-audit-2026-07-28.md).
// A capability token in the URL must never survive into document.location (so
// gtag's ambient page_location can't capture it), the dataLayer, or a
// third-party request — checked against the request URL, POST body, AND Referer.
// Hermetic @ci run: GTM/GA4 don't load, so this asserts the app-layer defence —
// history.replaceState (layer 1) plus redactSensitiveUrl — which is what denies
// gtag the token in the first place.
const TOKEN = 'LEAKTEST123';

// One row per route that consumes a capability token, with the arrival URL.
const CASES = [
  { name: '?sale= on /koszyk', path: `/koszyk?sale=${TOKEN}` },
  { name: '?preview= on a PDP', path: `/kubki/k01?preview=${TOKEN}` },
  {
    name: 'Stripe params on /koszyk/return',
    path: `/koszyk/return?payment_intent=pi_${TOKEN}&payment_intent_client_secret=pi_${TOKEN}_secret_x`,
  },
];

test.describe('@ci analytics token redaction', () => {
  for (const { name, path } of CASES) {
    test(`${name}: token never reaches URL, dataLayer, or a third party`, async ({
      page,
    }) => {
      const externalLeaks: string[] = [];
      page.on('request', (req) => {
        const url = req.url();
        // Legitimate token destinations, excluded like a first-party host:
        //  - localhost: the initial navigation + the /api/private-sale POST.
        //  - *.stripe.com: the /koszyk/return retrieve — the client secret's
        //    intended home (Stripe.js loads via the placeholder key), not a
        //    third-party analytics sink.
        if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) return;
        if (/^https:\/\/([a-z0-9-]+\.)*stripe\.com\//i.test(url)) return;
        // Flag a leak via URL, POST body, OR Referer — a cross-origin request whose
        // URL and body are clean can still carry the token in its Referer header.
        const referer = req.headers()['referer'] ?? '';
        if (
          url.includes(TOKEN) ||
          (req.postData() ?? '').includes(TOKEN) ||
          referer.includes(TOKEN)
        ) {
          externalLeaks.push(url);
        }
      });

      await page.goto(path);

      // Wait until the analytics layer has run at least once. On localhost,
      // pushDataLayer mirrors event names onto this dataset (the acc_analytics_debug
      // QA hook, src/lib/analytics.ts:456) — its presence proves page_view fired.
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.accAnalyticsDebug ?? ''))
        .not.toBe('');

      // Layer 1: the strip removed the token from the address bar. Polled because
      // /koszyk/return defers the strip until stripe.retrievePaymentIntent settles.
      await expect
        .poll(() => page.evaluate(() => window.location.href), { timeout: 15_000 })
        .not.toContain(TOKEN);
      expect(await page.evaluate(() => window.location.search)).not.toContain(TOKEN);

      // Nothing in the dataLayer carries the raw token (app-layer redactSensitiveUrl).
      const dataLayerHasToken = await page.evaluate((t) => {
        const dl = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
        return JSON.stringify(dl).includes(t);
      }, TOKEN);
      expect(dataLayerHasToken).toBe(false);

      // No cross-origin request leaked it via URL, body, or Referer.
      expect(externalLeaks).toEqual([]);
    });
  }
});
