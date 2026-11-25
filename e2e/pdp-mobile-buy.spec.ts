import { test, expect, type Page } from '@playwright/test';
import { CART_KEY, resetCart, sel } from './helpers/checkout';
import { COOKIE_NAME } from '../src/components/consent/consent-mode';

/**
 * T5 (docs/plans/2026-11-25-conversion-audit-action-plan.md): on a phone the
 * PDP's inline add-to-cart button sits ~1 300 px below the fold, so a sticky
 * "price + add" bar keeps a buy control on the first screen; once the piece
 * is in the cart it yields to the selection bar, which must show its count
 * and total at 390 px.
 * @ci-safe — cart state only; every piece is purchasable thanks to
 * E2E_CERAMIC_SALE_FIXTURE (playwright.config.ts); /api/checkout is never called.
 */

const buybar = '[data-testid="pdp-buybar"]';
const buybarAdd = '[data-testid="pdp-buybar-add"]';
const inlineAdd = '.pdp-body [data-testid="ceramic-add"]';
const selbar = '[data-testid="selbar"]';

/** Purchasable kubki PDP URLs, read off the category page's tiles. */
async function purchasablePdps(page: Page, count: number): Promise<string[]> {
  await page.goto('/kubki');
  const tiles = page.locator(`${sel.productTile}:not([data-sold="true"]):not([data-showroom="true"])`);
  await expect(tiles.first()).toBeVisible();
  const ids = (await tiles.evaluateAll((els) => els.map((el) => el.getAttribute('data-product-id')))).filter(Boolean);
  expect(ids.length, 'fixture must expose enough purchasable mugs').toBeGreaterThanOrEqual(count);
  return ids.slice(0, count).map((id) => `/kubki/${id}`);
}

const cartIds = (page: Page) =>
  page.evaluate((key) => {
    const ids: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')?.state?.ids;
    return Array.isArray(ids) ? (ids as string[]) : [];
  }, CART_KEY);

/** A tap before hydration is a no-op: retry until the piece reaches the cart. */
async function tapStickyAdd(page: Page, id: string) {
  await expect(async () => {
    if (!(await cartIds(page)).includes(id)) await page.locator(buybarAdd).click();
    expect(await cartIds(page)).toContain(id);
  }).toPass({ timeout: 10_000 });
}

/** Skip the consent banner unless a test wants it (it shifts both bars up). */
async function preConsent(page: Page, baseURL: string | undefined) {
  await page.context().addCookies([{ name: COOKIE_NAME, value: 'denied', url: baseURL ?? 'http://localhost:3000' }]);
}

test.describe('mobile PDP buy control @ci', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a buy control is on the first screen and hands over to the selection bar', async ({ page, baseURL }) => {
    await resetCart(page);
    await preConsent(page, baseURL);
    const [url] = await purchasablePdps(page, 1);
    const id = url.split('/').pop()!;
    await page.goto(url);

    // The inline button is far below the fold; the sticky bar is not.
    await expect(page.locator(inlineAdd)).not.toBeInViewport();
    await expect(page.locator(buybarAdd)).toBeInViewport();
    await expect(page.locator(`${buybar} .pdp-buybar-price`)).toHaveText(await page.locator('.pdp-price').innerText());

    await tapStickyAdd(page, id);

    // In the cart: the sticky bar leaves, the selection bar takes the slot
    // and shows "1 praca · razem <price>" in full at 390 px.
    await expect(page.locator(buybar)).not.toBeInViewport();
    const bar = page.locator(`${selbar}.show`);
    await expect(bar).toBeInViewport();
    const inner = await bar.locator('.selbar-inner').boundingBox();
    for (const part of ['.cnt', '.sum']) {
      const loc = bar.locator(`.selbar-info ${part}`);
      await expect(loc).toBeVisible();
      const box = await loc.boundingBox();
      expect(box, `${part} must be laid out`).not.toBeNull();
      expect(box!.width, `${part} must not be squeezed out`).toBeGreaterThan(30);
      expect(box!.x + box!.width, `${part} must not be clipped`).toBeLessThanOrEqual(
        (await bar.locator('.selbar-actions').boundingBox())!.x,
      );
      expect(box!.x).toBeGreaterThanOrEqual(inner!.x);
    }
    await expect(bar.locator('.cnt')).toContainText('1');
    await expect(bar.locator('.sum')).toContainText(await page.locator('.pdp-price').innerText());
    // "Clear" is demoted to an icon on phones but keeps its accessible name.
    await expect(bar.getByRole('button', { name: 'Wyczyść' })).toBeVisible();
    const clearBox = (await bar.locator('.clear').boundingBox())!;
    const goBox = (await bar.locator('.go').boundingBox())!;
    expect(clearBox.width).toBeLessThan(goBox.width / 2);
  });

  test('the sticky bar steps aside while the inline button is on screen', async ({ page, baseURL }) => {
    await resetCart(page);
    await preConsent(page, baseURL);
    const [url] = await purchasablePdps(page, 1);
    await page.goto(url);
    await expect(page.locator(buybarAdd)).toBeInViewport();

    await page.locator(inlineAdd).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await expect(page.locator(buybar)).not.toBeInViewport();
    // Past it (into "more from" and the footer) the bar stays away.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.locator(buybar)).not.toBeInViewport();

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator(buybarAdd)).toBeInViewport();
  });

  test('with another piece in the cart the selection bar yields above the inline button and is unreachable meanwhile', async ({ page, baseURL }) => {
    await resetCart(page);
    await preConsent(page, baseURL);
    const [first, second, third] = await purchasablePdps(page, 3);

    await page.goto(first);
    await tapStickyAdd(page, first.split('/').pop()!);

    await page.goto(second);
    await expect(page.locator(buybarAdd)).toBeInViewport();
    // Yielded = off-screen AND out of the tab order / a11y tree: "Wyczyść"
    // would empty a non-empty cart.
    await expect(page.locator(selbar)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Wyczyść' })).toHaveCount(0);

    // Past the inline button the buy bar has done its job: the checkout link
    // comes back for a visitor who already holds a piece.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.locator(buybar)).not.toBeInViewport();
    await expect(page.locator(`${selbar}.show`)).toBeInViewport();
    await expect(page.locator(`${selbar} .cnt`)).toContainText('1');

    await page.evaluate(() => window.scrollTo(0, 0));
    await tapStickyAdd(page, second.split('/').pop()!);
    await expect(page.locator(buybar)).not.toBeInViewport();
    await expect(page.locator(`${selbar}.show`)).toBeInViewport();
    await expect(page.locator(`${selbar} .cnt`)).toContainText('2');

    // Empty cart elsewhere: the hidden bar is not focusable either.
    await page.evaluate((key) => localStorage.removeItem(key), CART_KEY);
    await page.goto(third);
    await expect(page.locator(selbar)).toBeHidden();
  });

  for (const cartFilled of [false, true]) {
    test(`at max scroll no fixed bar covers the end of the footer (cart ${cartFilled ? 'filled' : 'empty'})`, async ({ page, baseURL }) => {
      await resetCart(page);
      await preConsent(page, baseURL);
      const [url] = await purchasablePdps(page, 1);
      await page.goto(url);
      if (cartFilled) await tapStickyAdd(page, url.split('/').pop()!);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(async () => {
        const end = (await page.locator('.footer-bot').boundingBox())!;
        for (const bar of await page.locator(`${selbar}.show .selbar-inner, ${buybar}.show .pdp-buybar-inner`).all()) {
          const box = (await bar.boundingBox())!;
          expect(end.y + end.height, 'footer end must clear the fixed bar').toBeLessThanOrEqual(box.y);
        }
      }).toPass({ timeout: 5_000 });
    });
  }

  test('the sticky bar sits above the open consent banner', async ({ page, context }) => {
    await context.clearCookies();
    await resetCart(page);
    const [url] = await purchasablePdps(page, 1);
    await page.goto(url);
    const banner = page.locator('[role="dialog"].consent');
    await expect(banner).toBeVisible({ timeout: 8_000 });

    await expect(async () => {
      const bar = (await page.locator(`${buybar} .pdp-buybar-inner`).boundingBox())!;
      const consent = (await banner.boundingBox())!;
      expect(bar.y + bar.height).toBeLessThanOrEqual(consent.y + 1);
    }).toPass({ timeout: 5_000 });
    await expect(page.locator(buybarAdd)).toBeInViewport();
  });
});

test.describe('desktop PDP keeps the inline button only @ci', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('no sticky buy bar on desktop', async ({ page, baseURL }) => {
    await resetCart(page);
    await preConsent(page, baseURL);
    const [url] = await purchasablePdps(page, 1);
    await page.goto(url);
    await expect(page.locator(inlineAdd)).toBeVisible();
    await expect(page.locator(buybar)).toBeHidden();
  });
});
