import { test, expect } from '@playwright/test';

// C-core: the PDP shows an all-in estimated total = item + locker shipping, per
// display currency. `@ci` lives in each title so `--grep @ci` selects them.
// Amounts mirror src/lib/pricing.test.ts: kubki = PLN 95 / EUR 25 / GBP 22;
// paczkomat = PLN 20 / EUR 5 / GBP 5.
test('@ci PDP estimated total includes locker shipping — PLN', async ({ page }) => {
  // pl → PLN. 95 + 20 = 115.
  await page.goto('/kubki/k01');
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/115\s*zł/);
  await expect(page.getByTestId('pdp-delivery')).toContainText(/20\s*zł/); // locker option
});

test('@ci PDP estimated total includes locker shipping — EUR', async ({ page }) => {
  // /en defaults to EUR (no CF-IPCountry in test). 25 + 5 = 30.
  await page.goto('/en/kubki/k01');
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/30\s*€/);
});

test('@ci PDP estimated total includes locker shipping — GBP', async ({ page }) => {
  // /en + currency_pref=gbp → GBP. 22 + 5 = 27. gbp() formats as "£27".
  await page.goto('/en/kubki/k01');
  // The middleware seeds currency_pref=eur as a Secure cookie on first visit
  // (NODE_ENV=production even under `npm run start`); Chromium refuses to let a
  // non-Secure addCookies() overwrite a Secure cookie on http://localhost, so
  // drop the seeded cookie before setting the GBP preference.
  await page.context().clearCookies({ name: 'currency_pref' });
  await page.context().addCookies([{ name: 'currency_pref', value: 'gbp', url: page.url() }]);
  await page.reload();
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/£\s*27/);
});
