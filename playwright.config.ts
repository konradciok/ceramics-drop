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
  // Safety rail: specs tagged @destructive (real payment, inventory reservation/
  // mutation) are excluded from EVERY run — including bare `npx playwright test` —
  // unless explicitly opted in with E2E_DESTRUCTIVE=1.
  grepInvert: process.env.E2E_DESTRUCTIVE === '1' ? undefined : /@destructive/,
  // Checkout specs run serially within a file, but distinct @destructive FILES
  // would still run in parallel workers and race each other on shared inventory
  // (the decline spec reserving the same first-unsold piece the purchase spec
  // picks). Force a single worker in CI and for every destructive run.
  workers: process.env.CI || process.env.E2E_DESTRUCTIVE === '1' ? 1 : undefined,
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
