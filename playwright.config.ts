import { defineConfig } from '@playwright/test';

/**
 * E2E config — see docs/e2e-playwright-purchase-flow.md.
 *
 * Default target is the deployed storefront (NOT localhost): the Stripe
 * Dashboard webhooks and Geowidget token are wired to that host. Override with
 * PLAYWRIGHT_BASE_URL for previews / local runs.
 *
 *   npx playwright test --grep @ci          # mocked, repo-safe specs
 *   npx playwright test --grep @checkout-edge  # includes the real-Stripe decline spec
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Checkout specs run serially within a file; keep one worker in CI so
  // @destructive flows never overlap on shared inventory.
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'https://anna-ciok.studio',
    // Specs assert Polish copy; without this, next-intl redirects to /en.
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
