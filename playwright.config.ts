import { defineConfig } from '@playwright/test';

/**
 * E2E config — see docs/e2e-playwright-purchase-flow.md.
 *
 * Default target is the hermetic localhost: a bare `npx playwright test` builds
 * and serves the app itself (see webServer below) rather than hammering the
 * production host. This is also required for @ci specs — Cloudflare bot
 * management serves CI/runner IPs a challenge page on the prod host, leaving
 * zero product tiles for the specs to find.
 *
 * To run against prod (real Stripe Dashboard webhook wiring + Geowidget token),
 * opt in explicitly:
 *
 *   PLAYWRIGHT_BASE_URL=https://anna-ciok.studio npx playwright test
 *
 *   npx playwright test --grep @ci            # mocked, repo-safe specs
 *   npx playwright test --grep @checkout-edge # includes the real-Stripe decline spec
 */
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
// A localhost target means the hermetic mode: Playwright builds/serves the app
// itself (see webServer below). Now the default, so local runs are hermetic.
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
  // Hermetic mode only: when pointed at localhost, build (if needed) and serve
  // the app so @ci specs run against our own artifact, not the Cloudflare-fronted
  // prod host. Omitted when PLAYWRIGHT_BASE_URL targets a deployed host.
  webServer: IS_LOCAL
    ? {
        command: 'test -d .next || npm run build; npm run start',
        url: BASE_URL,
        // Build can take several minutes on a cold tree; CI pre-builds so this
        // usually only waits for `next start`.
        timeout: 300_000,
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN:
            process.env.NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN ?? 'e2e-placeholder',
          NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
            process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? 'pk_test_e2e_placeholder',
        },
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
