import { test, expect, type Locator } from '@playwright/test';
import { resetCart, goToCart } from './helpers/checkout';

/**
 * Guard against the giant-SVG button regression: Icon renders viewBox-only
 * SVGs, so a `.btn` icon without a sizing rule expands to the button's full
 * width (production audit measured the checkout CTA at ~719×571 px). The
 * `.btn svg` rule in site.css must keep every button pill-sized.
 * @ci-safe — cart state only; /api/checkout is never called.
 */
test.describe('button svg sizing @ci', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  async function expectPillSized(btn: Locator, label: string) {
    await expect(btn).toBeVisible();
    const box = await btn.boundingBox();
    expect(box, `${label} must be in the layout`).not.toBeNull();
    expect(box!.height, `${label} must stay pill-sized, not svg-inflated`).toBeLessThan(100);
  }

  test('empty-cart primary CTA stays pill-sized', async ({ page }) => {
    await resetCart(page);
    await goToCart(page);
    await expectPillSized(page.locator('.cart-empty .btn-primary'), 'empty-cart CTA');
  });

  test('checkout CTA stays pill-sized', async ({ page }) => {
    await resetCart(page);
    // A print, not a ceramic: ceramic purchasability now depends on
    // onlineAvailable (the active-drop gate), which fails closed without a
    // real backend — the print path has no such gate.
    await page.goto('/fine-art-prints/fap005');
    await page.getByTestId('opt-size-50x70').click();
    await page.getByTestId('print-add').click();
    await goToCart(page);
    await expectPillSized(page.locator('[data-testid="checkout-button"]'), 'checkout CTA');
  });
});
