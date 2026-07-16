/**
 * Mint a new drop row. Creating a drop is as rare as a catalogue refresh, so it
 * is a one-off script (mirroring `create-private-sale-link.ts`) rather than an
 * admin form. Ending a drop and toggling showroom are the everyday actions and
 * live in /admin/inventory.
 *
 * Usage:
 *   npm run drop:create -- --label "Drop #2 — Wrzesień 2026"
 *   npm run drop:create -- --id drop-2 --label "Drop #2"
 *
 * After inserting the row, add DROP_OVERRIDE entries in src/lib/products.ts for
 * the new pieces' ids so they report the new drop.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars / env).
 */
import { parseArgs as nodeParseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnv } from './lib/script-env';

/** slugify a label into a drop id when --id isn't given. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics (ą, ł, ż …)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function main(): Promise<void> {
  // strict + no positionals: a typo'd flag (e.g. --idd) aborts instead of
  // silently falling back to a slugified id. 'env-file' is declared so it
  // doesn't trip the strict gate — loadLocalEnv() consumes it from argv.
  const { values } = nodeParseArgs({
    options: { label: { type: 'string' }, id: { type: 'string' }, 'env-file': { type: 'string' } },
  });
  const label = typeof values.label === 'string' ? values.label : undefined;
  if (!label) throw new Error('Missing --label (display label, e.g. --label "Drop #2").');

  const id = ((typeof values.id === 'string' ? values.id : undefined) ?? slugify(label)).trim();
  if (!id) throw new Error('Could not derive a drop id — pass --id explicitly.');

  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .dev.vars, .env.local, or process env.');
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { error } = await supabase
    .from('drops')
    .insert({ id, label, status: 'active', started_at: new Date().toISOString() });
  if (error) throw new Error(`Insert failed: ${error.message}`);

  console.log('\nDrop created.');
  console.log(`  id:     ${id}`);
  console.log(`  label:  ${label}`);
  console.log('\nNext: add DROP_OVERRIDE entries in src/lib/products.ts mapping the new pieces to this id.\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
