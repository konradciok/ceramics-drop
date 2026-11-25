import { test, expect, type Page } from '@playwright/test';

// C-core: the PDP shows an all-in estimated total = item + locker shipping, per
// display currency, the locker price of each zone checkout ships to (Spain, every
// other country; courier and studio pickup are switched off) and the trust line.
// `@checkout-edge` lives in each title so `--grep @checkout-edge` selects them —
// the delivery block only renders when onlineAvailable is true (active-drop
// gate), which fails closed without a real backend, so this can't run in the
// hermetic @ci job. Amounts mirror src/lib/pricing.test.ts: kubki = PLN 95 /
// EUR 25 / GBP 22; lockers (DEFAULT_LOCKER_SHIPPING, the published revision 1):
// Spain = PLN 43, EUR 10, GBP 9; other countries = PLN 65, EUR 15, GBP 13.
// The estimate uses the visitor's country (CF-IPCountry, then the locale), and
// the edge run's IP country is not fixed, so it may be either zone. Regexes are
// anchored so a wrong value containing the digits (e.g. "1150 zł") can't pass.

async function expectZoneRows(page: Page, es: RegExp, eu: RegExp) {
  const block = page.getByTestId('pdp-delivery');
  await expect(block.locator('.pdp-delivery-opts li')).toHaveCount(2);
  await expect(block.getByTestId('pdp-locker-es').locator('span').nth(1)).toHaveText(es);
  await expect(block.getByTestId('pdp-locker-eu').locator('span').nth(1)).toHaveText(eu);
  await expect(block.locator('.pdp-delivery-trust')).toHaveText(/price you pay|cena, którą płacisz/i);
}

test('@checkout-edge PDP delivery block: estimated total, zones, trust — PLN', async ({ page }) => {
  // pl → PLN. 95 + 65 = 160 (Poland or another 'eu' country) or 95 + 43 = 138 (Spain).
  await page.goto('/kubki/k01');
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/^(160|138)\s*zł$/);
  await expectZoneRows(page, /^43\s*zł$/, /^65\s*zł$/);
});

test('@checkout-edge PDP delivery block: estimated total, zones, trust — EUR', async ({ page }) => {
  // /en defaults to EUR. 25 + 10 = 35 (Spain, the en default) or 25 + 15 = 40.
  await page.goto('/en/kubki/k01');
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/^(35|40)\s*€$/);
  await expectZoneRows(page, /^10\s*€$/, /^15\s*€$/);
});

test('@checkout-edge PDP delivery block: estimated total, zones, trust — GBP', async ({ page }) => {
  // /en + currency_pref=gbp → GBP. 22 + 9 = 31 or 22 + 13 = 35. gbp() formats as "£35".
  await page.goto('/en/kubki/k01');
  // The middleware seeds currency_pref=eur as a Secure cookie on first visit
  // (NODE_ENV=production even under `npm run start`); Chromium refuses to let a
  // non-Secure addCookies() overwrite a Secure cookie on http://localhost, so
  // drop the seeded cookie before setting the GBP preference.
  await page.context().clearCookies({ name: 'currency_pref' });
  await page.context().addCookies([{ name: 'currency_pref', value: 'gbp', url: page.url() }]);
  await page.reload();
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/^£\s*(31|35)$/);
  await expectZoneRows(page, /^£\s*9$/, /^£\s*13$/);
});
