import { test, expect } from '@playwright/test';

// C-core: the PDP shows an all-in estimated total = item + locker shipping, per
// display currency, plus the InPost locker option (courier and studio pickup are switched off) and the trust line. `@checkout-edge`
// lives in each title so `--grep @checkout-edge` selects them — the delivery
// block only renders when onlineAvailable is true (active-drop gate), which
// fails closed without a real backend, so this can't run in the hermetic @ci
// job. Amounts mirror src/lib/pricing.test.ts: kubki = PLN 95 / EUR 25 /
// GBP 22; locker shipping to Poland = lockers zone 'eu' = PLN 65, EUR 15,
// GBP 13 (DEFAULT_LOCKER_SHIPPING, the published revision 1). Regexes
// are anchored so a wrong value containing the digits as a substring (e.g.
// "1150 zł") can't pass.
test('@checkout-edge PDP delivery block: estimated total, options, trust — PLN', async ({ page }) => {
  // pl → PLN. 95 + 65 = 160.
  await page.goto('/kubki/k01');
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/^160\s*zł$/);
  const opts = page.getByTestId('pdp-delivery').locator('.pdp-delivery-opts li');
  await expect(opts).toHaveCount(1);
  await expect(opts.nth(0).locator('span').nth(1)).toHaveText(/^65\s*zł$/); // paczkomat
  await expect(page.getByTestId('pdp-delivery').locator('.pdp-delivery-trust')).toBeVisible();
});

test('@checkout-edge PDP delivery block: estimated total, options, trust — EUR', async ({ page }) => {
  // /en defaults to EUR (no CF-IPCountry in test). 25 + 15 = 40.
  await page.goto('/en/kubki/k01');
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/^40\s*€$/);
  const opts = page.getByTestId('pdp-delivery').locator('.pdp-delivery-opts li');
  await expect(opts).toHaveCount(1);
  await expect(opts.nth(0).locator('span').nth(1)).toHaveText(/^15\s*€$/); // paczkomat
  await expect(page.getByTestId('pdp-delivery').locator('.pdp-delivery-trust')).toBeVisible();
});

test('@checkout-edge PDP delivery block: estimated total, options, trust — GBP', async ({ page }) => {
  // /en + currency_pref=gbp → GBP. 22 + 13 = 35. gbp() formats as "£35".
  await page.goto('/en/kubki/k01');
  // The middleware seeds currency_pref=eur as a Secure cookie on first visit
  // (NODE_ENV=production even under `npm run start`); Chromium refuses to let a
  // non-Secure addCookies() overwrite a Secure cookie on http://localhost, so
  // drop the seeded cookie before setting the GBP preference.
  await page.context().clearCookies({ name: 'currency_pref' });
  await page.context().addCookies([{ name: 'currency_pref', value: 'gbp', url: page.url() }]);
  await page.reload();
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/^£\s*35$/);
  const opts = page.getByTestId('pdp-delivery').locator('.pdp-delivery-opts li');
  await expect(opts).toHaveCount(1);
  await expect(opts.nth(0).locator('span').nth(1)).toHaveText(/^£\s*13$/); // paczkomat
  await expect(page.getByTestId('pdp-delivery').locator('.pdp-delivery-trust')).toHaveText(
    /import charges on delivery/i,
  );
});
