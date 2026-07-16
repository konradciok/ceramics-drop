import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';
import { execFileSync } from 'node:child_process';
import packageJson from './package.json';

// Build-time version stamp. `NEXT_PUBLIC_*` values are inlined into the bundle by
// `next build`, so the running Worker reports the version it shipped with. The
// package.json version is the single source of truth (release-please bumps it);
// the git SHA is best-effort — `git` may be absent in some build images, so fall
// back to 'dev' rather than fail the build.
const gitSha = (() => {
  try {
    // execFileSync (no shell, arg array) — nothing interpolated.
    return execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  } catch {
    return 'dev';
  }
})();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
    NEXT_PUBLIC_GIT_SHA: gitSha,
  },
  allowedDevOrigins: [
    'studio-admin-konradciok.local',
    'studio-admin.local',
    'studio-admin.home.arpa',
  ],
  async headers() {
    return [
      {
        source: '/uploads/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=604800' }],
      },
      {
        source: '/fonts/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withSentryConfig(withNextIntl(nextConfig), {
  org: 'y9608071l-anna-ciok',
  project: 'ceramics-drop',
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Tag uploaded source maps with the same release the runtime reports
  // (src/lib/sentry-options.ts), so Sentry un-minifies stack traces per version.
  release: { name: packageJson.version },
  silent: !process.env.CI,
  tunnelRoute: '/sentry-tunnel',
  widenClientFileUpload: true,
});

import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

initOpenNextCloudflareForDev();
