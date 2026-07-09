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
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

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

function getArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

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
  const label = getArg('label');
  if (!label) throw new Error('Missing --label (display label, e.g. --label "Drop #2").');

  const id = (getArg('id') ?? slugify(label)).trim();
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
