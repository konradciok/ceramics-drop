import { test, expect, type Page } from '@playwright/test';

// C-core: the PDP shows an all-in total = item + locker shipping, per display
// currency, the locker price of the visitor's country (courier and studio
// pickup are switched off) and the trust line. `@checkout-edge` lives in each
// title so `--grep @checkout-edge` selects them — the delivery block only
// renders when onlineAvailable is true (active-drop gate), which needs a real
// backend here (the hermetic @ci counterpart, with the zone-row fallback, is
// e2e/pdp-delivery-per-parcel.spec.ts). Amounts mirror src/lib/pricing.test.ts:
// kubki = PLN 95 / EUR 25 / GBP 22; lockers (DEFAULT_LOCKER_SHIPPING, the
// published revision 1): Spain = PLN 43, EUR 10, GBP 9; other countries =
// PLN 65, EUR 15, GBP 13. The edge run's IP country is not fixed, so each test
// saves a delivery country (the cart's `delivery_country` cookie), which wins
// over CF-IPCountry and makes the country known. Regexes are anchored so a
// wrong value containing the digits (e.g. "1150 zł") can't pass.

async function saveDeliveryCountry(page: Page, country: string) {
  await page.context().addCookies([{ name: 'delivery_country', value: country, url: page.url() }]);
  await page.reload();
}

async function expectCountryRow(page: Page, country: RegExp, price: RegExp) {
  const block = page.getByTestId('pdp-delivery');
  await expect(block.locator('.pdp-delivery-opts li')).toHaveCount(1);
  const row = block.getByTestId('pdp-locker-country');
  await expect(row.locator('span').first()).toHaveText(country);
  await expect(row.locator('span').nth(1)).toHaveText(price);
  await expect(page.getByTestId('pdp-per-parcel')).toBeVisible();
  await expect(block.locator('.pdp-delivery-trust')).toHaveText(/price you pay|cena, którą płacisz/i);
}

test('@checkout-edge PDP delivery block: total, country, trust — PLN', async ({ page }) => {
  // pl → PLN, Poland: 95 + 65 = 160.
  await page.goto('/kubki/k01');
  await saveDeliveryCountry(page, 'PL');
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/^160\s*zł$/);
  await expectCountryRow(page, /Polska/, /^65\s*zł$/);
});

test('@checkout-edge PDP delivery block: total, country, trust — EUR', async ({ page }) => {
  // /en defaults to EUR, Spain: 25 + 10 = 35.
  await page.goto('/en/kubki/k01');
  await saveDeliveryCountry(page, 'ES');
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/^35\s*€$/);
  await expectCountryRow(page, /Spain/, /^10\s*€$/);
});

test('@checkout-edge PDP delivery block: total, country, trust — GBP', async ({ page }) => {
  // /en + currency_pref=gbp → GBP, Germany: 22 + 13 = 35. gbp() formats as "£35".
  await page.goto('/en/kubki/k01');
  // The middleware seeds currency_pref=eur as a Secure cookie on first visit
  // (NODE_ENV=production even under `npm run start`); Chromium refuses to let a
  // non-Secure addCookies() overwrite a Secure cookie on http://localhost, so
  // drop the seeded cookie before setting the GBP preference.
  await page.context().clearCookies({ name: 'currency_pref' });
  await page.context().addCookies([{ name: 'currency_pref', value: 'gbp', url: page.url() }]);
  await saveDeliveryCountry(page, 'DE');
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/^£\s*35$/);
  await expectCountryRow(page, /Germany/, /^£\s*13$/);
});
