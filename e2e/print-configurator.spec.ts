import { test, expect } from '@playwright/test';

test.describe('fine-art print configurator @ci', () => {
  test('renders configurator and adds print to cart', async ({ page }) => {
    await page.goto('/fine-art-prints/fap01');
    // Variant options render as radiogroup buttons (role="radio"), so they are
    // addressed by test id rather than the implicit button role.
    await page.getByTestId('opt-size-50x70').click();
    await page.getByTestId('opt-framed-true').click();
    await page.getByTestId('opt-colour-black').click();
    await page.getByTestId('print-add').click();
    // Header badge (CartCount) exposes the piece count via data-cart-count.
    await expect(page.locator('[data-cart-count]')).toHaveText('1');
  });

  test('unframed variant shows no colour/mount selectors', async ({ page }) => {
    await page.goto('/fine-art-prints/fap01');
    await page.getByTestId('opt-framed-false').click();
    await expect(page.getByTestId('opt-colour-black')).not.toBeVisible();
    await expect(page.getByTestId('opt-mount-false')).not.toBeVisible();
  });

  test('styles selector controls and updates mounted variant price', async ({ page }) => {
    await page.goto('/fine-art-prints/fap01');

    await expect(page.locator('.print-axis').first()).toHaveCSS('border-width', '0px');
    await expect(page.getByTestId('opt-size-30x40')).toHaveAttribute('aria-checked', 'true');

    await page.getByTestId('opt-size-70x100').click();
    await expect(page.getByTestId('opt-size-30x40')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('opt-size-70x100')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('opt-framed-true').click();
    await page.getByTestId('opt-colour-natural').click();
    await page.getByTestId('opt-mount-true').click();

    await expect(page.getByTestId('opt-mount-true')).toHaveAttribute('aria-checked', 'true');
    // 720 zł = 70x100 base 190 + frame 485 + mount 45 (src/lib/print-pricing.ts).
    // Pinned literal: update here when SIZE_BASE / *_DELTA tables change.
    await expect(page.getByTestId('print-price')).toHaveText('720 zł');
  });

  test('fires the print funnel: list → select → view → add → remove', async ({ page }) => {
    // pushDataLayer mirrors each event into sessionStorage on localhost (analytics.ts
    // mirrorDebugEvent); poll because view_item_list / view_item fire in mount effects.
    const events = () =>
      page.evaluate(() =>
        (JSON.parse(sessionStorage.getItem('acc_analytics_debug') ?? '[]') as { event: string }[]).map(
          (e) => e.event,
        ),
      );

    await page.goto('/fine-art-prints');
    await expect.poll(events).toContain('view_item_list');

    await page.getByTestId('print-tile').first().click();
    await expect.poll(events).toContain('select_item');
    await expect.poll(events).toContain('view_item'); // landed on the print PDP

    await page.getByTestId('print-add').click();
    await expect(page.locator('[data-cart-count]')).toHaveText('1');
    await expect.poll(events).toContain('add_to_cart');

    await page.getByTestId('print-add').click(); // in-cart toggle → remove
    await expect.poll(events).toContain('remove_from_cart');

    // The polls above only prove each event arrived, not that the funnel
    // progressed in order. Assert the five events appear as a subsequence of the
    // recorded buffer (subsequence, not equality — unrelated events like
    // page_view interleave and must not fail the test).
    const recorded = await events();
    let cursor = -1;
    for (const name of ['view_item_list', 'select_item', 'view_item', 'add_to_cart', 'remove_from_cart']) {
      const at = recorded.indexOf(name, cursor + 1);
      expect(at, `${name} out of order in ${recorded.join(' → ')}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });
});
