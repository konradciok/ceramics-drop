import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Cross-agent tripwire for the one rule whose violation takes production down:
 * OpenNext cannot load Turbopack chunks at the Cloudflare Workers runtime
 * (ChunkLoadError → HTTP 500 on every page). See AGENTS.md § Build system.
 *
 * This runs in `npm test` locally and in CI, so EVERY agent and contributor
 * hits it regardless of editor/tooling — unlike the Claude Code PreToolUse
 * hook in `.claude/settings.json`, which only guards interactive sessions.
 * If you are here because this test failed: restore `next build --webpack`
 * and do not add `--turbo`/`--turbopack` anywhere. This is intentional and
 * non-negotiable; do not weaken this test to make a build change pass.
 */
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };
const wranglerConfig = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const dbWorkflow = readFileSync(new URL('../.github/workflows/db.yml', import.meta.url), 'utf8');

describe('build configuration (Cloudflare Workers safety)', () => {
  it('build script is exactly `next build --webpack`', () => {
    expect(pkg.scripts.build).toBe('next build --webpack');
  });

  it('dev script uses webpack', () => {
    expect(pkg.scripts.dev).toContain('--webpack');
  });

  it('fails closed on the Next manifests after every production build', () => {
    expect(pkg.scripts.postbuild).toBe('npm run verify:catalog-runtime:next');
    expect(pkg.scripts['verify:catalog-runtime:next']).toBe(
      'tsx scripts/verify-catalog-runtime-artifact.ts --artifact next',
    );
  });

  it('gates every OpenNext preview/deploy path on the copied artifact', () => {
    expect(pkg.scripts['verify:catalog-runtime:opennext']).toBe(
      'tsx scripts/verify-catalog-runtime-artifact.ts --artifact opennext',
    );
    expect(pkg.scripts['build:opennext']).toBe(
      'opennextjs-cloudflare build && npm run verify:catalog-runtime:opennext',
    );
    expect(pkg.scripts['preview:cf']).toBe(
      'npm run build:opennext && opennextjs-cloudflare preview',
    );
    expect(pkg.scripts['deploy:cf']).toBe(
      'npm run build:opennext && opennextjs-cloudflare deploy',
    );
    expect(wranglerConfig).toMatch(
      /"build"\s*:\s*\{\s*"command"\s*:\s*"npm run build:opennext"\s*\}/,
    );
  });

  it('no script invokes Turbopack', () => {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(command, `script "${name}" must not use Turbopack`).not.toMatch(
        /--turbo\b|turbopack/i,
      );
    }
  });

  it('runs the fresh-schema catalog backfill rehearsal in database CI', () => {
    expect(dbWorkflow).toContain('supabase start');
    expect(dbWorkflow).toContain('supabase test db');
    expect(dbWorkflow).toContain('npm ci');
    expect(dbWorkflow).toContain('supabase status --output env');
    expect(dbWorkflow).not.toMatch(/supabase start[^\n]*\bgotrue\b/);
    expect(dbWorkflow).toContain('LOCAL_SUPABASE_URL');
    expect(dbWorkflow).toContain('LOCAL_SUPABASE_SERVICE_ROLE_KEY');
    expect(dbWorkflow).toContain("IFS='.' read -r jwt_header jwt_payload jwt_signature jwt_extra");
    expect(dbWorkflow).toContain(
      'npx vitest run scripts/catalog-backfill.local.test.ts',
    );
  });
});
