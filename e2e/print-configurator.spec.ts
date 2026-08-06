import { test, expect } from '@playwright/test';
import { PRINT_DESIGNS, registryPrintById } from '../src/lib/prints';

test.describe('fine-art print configurator @ci', () => {
  test('renders configurator and adds print to cart', async ({ page }) => {
    await page.goto('/fine-art-prints/fap005');
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
    await page.goto('/fine-art-prints/fap005');
    await page.getByTestId('opt-framed-false').click();
    await expect(page.getByTestId('opt-colour-black')).not.toBeVisible();
    await expect(page.getByTestId('opt-mount-false')).not.toBeVisible();
  });

  test('styles selector controls and updates mounted variant price', async ({ page }) => {
    await page.goto('/fine-art-prints/fap005');

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

  test('hero mockup follows configurator selection', async ({ page }) => {
    const design = registryPrintById('fap005');
    test.skip(!design?.mockups, 'fap005 mockup assets not published yet (flag off)');

    await page.goto('/fine-art-prints/fap005');
    const hero = page.locator('.pdp-img-main img');
    await expect(hero).toHaveAttribute('src', '/uploads/fap-005.webp');

    // Framing defaults to the first colour (black).
    await page.getByTestId('opt-framed-true').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-005-mock-framed-black.webp');

    await page.getByTestId('opt-mount-true').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-005-mock-mount-black.webp');

    await page.getByTestId('opt-colour-natural').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-005-mock-mount-natural.webp');

    await page.getByTestId('opt-framed-false').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-005.webp');

    // syncKey snap-back: from another slide, a visual-state change must return
    // the gallery to slide 0 (exercisable once fap005 ships a second gallery slide).
    if (design?.gallery?.length) {
      await page.getByTestId('opt-framed-true').click();
      await expect(hero).toHaveAttribute('src', '/uploads/fap-005-mock-framed-black.webp');
      await page.locator('.pdp-img-dot').nth(1).click();
      await expect(hero).toHaveAttribute('src', design.gallery[0]);
      await page.getByTestId('opt-colour-brown').click();
      await expect(hero).toHaveAttribute('src', '/uploads/fap-005-mock-framed-brown.webp');
    }
  });

  test('design without mockups keeps a static hero', async ({ page }) => {
    const design = PRINT_DESIGNS.find(
      (d) => d.published && !d.mockups && d.frameColours.length > 0 && (d.gallery?.length ?? 0) > 0,
    );
    test.skip(!design, 'no published mockup-less design with a gallery slide');

    await page.goto(`/fine-art-prints/${design!.id}`);
    const hero = page.locator('.pdp-img-main img');
    await expect(hero).toHaveAttribute('src', design!.image);
    await page.getByTestId('opt-framed-true').click();
    await expect(hero).toHaveAttribute('src', design!.image);

    // syncKey no-op half (live today): with a static hero the visual state
    // never changes, so browsing to another slide must survive option clicks.
    await page.locator('.pdp-img-dot').nth(1).click();
    await expect(hero).toHaveAttribute('src', design!.gallery![0]);
    await page.getByTestId('opt-colour-natural').click();
    await expect(hero).toHaveAttribute('src', design!.gallery![0]);
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
