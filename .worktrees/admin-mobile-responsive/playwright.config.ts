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
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://anna-ciok.studio';
// A localhost target means the hermetic mode: Playwright builds/serves the app
// itself (see webServer below) so the @ci specs never depend on the production
// host — where Cloudflare's bot management serves CI runner IPs a challenge page
// instead of the storefront, leaving zero product tiles for the specs to find.
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(BASE_URL);

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
  // Hermetic mode only: when pointed at localhost, build+serve the app so the
  // @ci specs run against our own deploy artifact, not the Cloudflare-fronted
  // prod host. Untouched for the default/release-gate runs against prod.
  webServer: IS_LOCAL
    ? {
        command: 'npm run start',
        url: BASE_URL,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    : undefined,
  use: {
    baseURL: BASE_URL,
    // Specs assert Polish copy; without this, next-intl redirects to /en.
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
