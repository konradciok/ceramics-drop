import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Cross-agent tripwire for finding C-2 (backend audit 2026-08-12).
 *
 * The Cloudflare Queue CONSUMER runs OUTSIDE the request AsyncLocalStorage that
 * OpenNext only populates for `fetch`. So `getSupabaseAdmin()` — which resolves
 * `getCloudflareContext().env` — THROWS on every queue delivery, dead-lettering
 * the job before any DB write. Code reachable from the queue consumer must build
 * its Supabase client from the explicit `env` (`supabaseFromEnv(env)`) or receive
 * it injected — never `getSupabaseAdmin` / `getCloudflareContext`.
 *
 * Scope note: `src/server/fulfilment/` MIXES contexts — `enqueue.ts` is the
 * PRODUCER (called from the Stripe webhook, inside the fetch ALS, so its
 * `getSupabaseAdmin()` is correct). Only `process-job.ts` runs in the queue
 * consumer, plus `getAssetForFulfilment` in the print-assets repository (whose
 * other exports are fetch-path). So we guard exactly those two surfaces, not a
 * blanket directory scan. If you add a new module that `processJob` reaches at
 * runtime, add it to QUEUE_CONSUMER_FILES below.
 *
 * This runs in `npm test` + CI. If you are here because it failed: you added an
 * ALS-dependent client to the queue call-tree. Inject the client instead.
 */

const FORBIDDEN = /getSupabaseAdmin|getCloudflareContext/;

/** Strip line + block comments so a doc comment mentioning the token doesn't trip the guard. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function read(rel: string): string {
  return stripComments(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
}

const QUEUE_CONSUMER_FILES = ['src/server/fulfilment/process-job.ts'];

describe('queue-context safety (C-2 regression guard)', () => {
  it.each(QUEUE_CONSUMER_FILES)(
    'queue-consumer module %s builds no ALS-dependent client',
    (rel) => {
      expect(
        FORBIDDEN.test(read(rel)),
        `${rel} must not use getSupabaseAdmin/getCloudflareContext (queue runs outside the request ALS — use supabaseFromEnv(env) or inject the client)`,
      ).toBe(false);
    },
  );

  it('getAssetForFulfilment (the queue-reachable repository fn) takes an injected client and builds none', () => {
    // repository.ts intentionally MIXES queue-reachable and fetch-path helpers
    // (the latter legitimately call getSupabaseAdmin), so we cannot blanket-scan
    // the file — assert the one queue-reachable export is injected.
    const src = read('src/server/print-assets/repository.ts');
    const start = src.indexOf('export async function getAssetForFulfilment(');
    expect(start, 'getAssetForFulfilment must exist in repository.ts').toBeGreaterThanOrEqual(0);
    const rest = src.slice(start + 'export async function getAssetForFulfilment('.length);
    const nextExport = rest.indexOf('\nexport ');
    const body = nextExport === -1 ? rest : rest.slice(0, nextExport);

    expect(body, 'getAssetForFulfilment must accept an injected SupabaseClient param').toMatch(
      /supabase:\s*SupabaseClient/,
    );
    expect(
      FORBIDDEN.test(body),
      'getAssetForFulfilment must NOT build its own client — it runs on the queue path',
    ).toBe(false);
  });
});
