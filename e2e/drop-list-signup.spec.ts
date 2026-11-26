import { test, expect, type Page } from '@playwright/test';

/**
 * Drop-list signups (T9, docs/plans/2026-11-25-conversion-audit-action-plan.md):
 * the existing double opt-in form placed where demand is lost. Each placement
 * POSTs to the existing /api/newsletter (stubbed here — the hermetic server has
 * no NEWSLETTER_CONFIRM_SECRET) and shows the existing "check your inbox"
 * state; nothing is subscribed until the emailed link is clicked.
 *
 * The sold-PDP placement is not covered here: the hermetic fixture renders
 * every piece as available (see playwright.config.ts). Its predicate is unit
 * tested in src/components/shop/ProductPageScreen.test.ts.
 */

type NewsletterPost = { email?: string; locale?: string };

/** Stub /api/newsletter and collect what the form sent. */
async function stubNewsletter(page: Page): Promise<NewsletterPost[]> {
  const posts: NewsletterPost[] = [];
  await page.route('**/api/newsletter', async (route) => {
    posts.push(route.request().postDataJSON() as NewsletterPost);
    await route.fulfill({ json: { ok: true } });
  });
  return posts;
}

/**
 * newsletter_signup_requested placements pushed to the dataLayer. Read from
 * window.dataLayer, not the acc_analytics_debug mirror — the mirror keeps only
 * event names, not params.
 */
function signupPlacements(page: Page) {
  return page.evaluate(() => {
    const dl = (window as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer ?? [];
    return dl
      .filter((e) => e && e.engagement_type === 'newsletter_signup_requested')
      .map((e) => e.placement);
  });
}

test.describe('drop-list signup @ci', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test('home: the hero secondary action jumps to the band, which submits as home_hero', async ({ page }) => {
    const posts = await stubNewsletter(page);
    await page.goto('/');

    const cta = page.getByTestId('hero-drop-list-cta');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', '#drop-list');
    // The shop button stays the hero's one primary CTA, and comes first.
    await expect(page.locator('.hero-actions > *').first()).toHaveClass(/btn-primary/);

    await cta.click();
    const band = page.getByTestId('home-drop-list');
    await expect(band).toBeInViewport();

    // Retry the fill until hydration has wired the controlled input.
    const submit = page.getByTestId('home-newsletter-submit');
    await expect(async () => {
      await page.getByTestId('home-newsletter-email').fill('drop+e2e@example.com');
      await expect(submit).toBeEnabled({ timeout: 500 });
    }).toPass();
    await submit.click();

    await expect(page.getByTestId('home-newsletter-thanks')).toBeVisible();
    expect(posts).toEqual([{ email: 'drop+e2e@example.com', locale: 'pl' }]);
    await expect.poll(() => signupPlacements(page)).toEqual(['home_hero']);
    // The footer form is a separate island, untouched.
    await expect(page.getByTestId('newsletter-email')).toBeVisible();
  });

  test('home: a failed POST shows the error and no confirmation state', async ({ page }) => {
    await page.route('**/api/newsletter', (route) => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
    await page.goto('/');
    const submit = page.getByTestId('home-newsletter-submit');
    await expect(async () => {
      await page.getByTestId('home-newsletter-email').fill('drop+e2e@example.com');
      await expect(submit).toBeEnabled({ timeout: 500 });
    }).toPass();
    await submit.click();
    await expect(page.getByTestId('home-drop-list').getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('home-newsletter-thanks')).toHaveCount(0);
    expect(await signupPlacements(page)).toEqual([]);
  });

  test('thank-you page: a paid order offers the signup as checkout_success', async ({ page }) => {
    // Stub Stripe.js so retrievePaymentIntent reports a succeeded intent.
    await page.route('https://js.stripe.com/**', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `window.Stripe = function () {
          return { retrievePaymentIntent: async function () {
            return { paymentIntent: { id: 'pi_e2e_droplist', status: 'succeeded' } };
          } };
        };`,
      }),
    );
    const posts = await stubNewsletter(page);
    await page.goto('/en/koszyk/return?payment_intent=pi_e2e_droplist&payment_intent_client_secret=pi_e2e_droplist_secret_x');

    await expect(page.getByTestId('checkout-success')).toBeVisible();
    const section = page.getByTestId('checkout-drop-list');
    await expect(section).toBeVisible();
    await page.getByTestId('checkout-newsletter-email').fill('buyer+e2e@example.com');
    await page.getByTestId('checkout-newsletter-submit').click();

    await expect(page.getByTestId('checkout-newsletter-thanks')).toBeVisible();
    expect(posts).toEqual([{ email: 'buyer+e2e@example.com', locale: 'en' }]);
    await expect.poll(() => signupPlacements(page)).toEqual(['checkout_success']);
  });

  test('thank-you page: a failed payment shows no signup', async ({ page }) => {
    await page.route('https://js.stripe.com/**', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `window.Stripe = function () {
          return { retrievePaymentIntent: async function () {
            return { paymentIntent: { id: 'pi_e2e_droplist_fail', status: 'requires_payment_method' } };
          } };
        };`,
      }),
    );
    await page.goto('/koszyk/return?payment_intent=pi_e2e_droplist_fail&payment_intent_client_secret=pi_e2e_droplist_fail_secret_x');
    await expect(page.locator('.confirm h1')).toBeVisible();
    await expect(page.getByTestId('checkout-drop-list')).toHaveCount(0);
  });
});
