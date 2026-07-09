/**
 * Backfill the shadow catalog tables (products / product_variants / product_media)
 * from the static code registry. Idempotent — safe to re-run after a catalogue
 * change; see backfillCatalog() in src/lib/catalog/repository.ts.
 *
 * Usage:
 *   npm run catalog:backfill
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars / env).
 * Requires migration 20260709140000_catalog_shadow (the tables) AND 20260709130000
 * (seeds the `drop-1` row that ceramic rows FK to). Run once against staging after
 * merge, then against production.
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { backfillCatalog } from '../src/lib/catalog/repository';
import { buildCatalogSeed } from '../src/lib/catalog/seed';

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const parsed: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadLocalEnv(): Record<string, string | undefined> {
  return {
    ...parseEnvFile('.env.local'),
    ...parseEnvFile('.dev.vars'),
    ...process.env,
  };
}

async function main(): Promise<void> {
  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .dev.vars, .env.local, or process env.');
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const seed = buildCatalogSeed();
  await backfillCatalog(supabase);

  console.log('\nCatalog backfill complete.');
  console.log(`  products: ${seed.products.length}`);
  console.log(`  variants: ${seed.variants.length}`);
  console.log(`  media:    ${seed.media.length}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
