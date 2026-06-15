/**
 * Mint a private-sale link: bind a secret token to an exact set of product ids so
 * a single customer can buy specific (already-`sold`) pieces via
 * `/koszyk?sale=<TOKEN>`, without relisting them in the public shop. See
 * docs/plans/private-sale-cart-link.md.
 *
 * Usage:
 *   npx tsx scripts/create-private-sale-link.ts --items k10,t18,t19,t22 --days 14
 *   npm run private-sale:create -- --items k10,t18,t19,t22 --days 14
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (from .env.local / .dev.vars / env).
 * Apply the 20260615120000_private_sales migration before running. For a real
 * customer, point this at the PRODUCTION Supabase (its URL/key in the env).
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { getProductById } from '../src/lib/products';

const DEFAULT_BASE_URL = 'https://anna-ciok.studio';

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

/** Minimal --flag value parser (supports `--flag value` and `--flag=value`). */
function getArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

async function main(): Promise<void> {
  const itemsArg = getArg('items');
  if (!itemsArg) throw new Error('Missing --items (comma-separated product ids, e.g. --items k10,t18,t19,t22).');

  const ids = [...new Set(itemsArg.split(',').map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error('--items resolved to no product ids.');

  const unknown = ids.filter((id) => !getProductById(id));
  if (unknown.length > 0) throw new Error(`Unknown product id(s): ${unknown.join(', ')}. Check the catalogue ids in src/lib/products.ts.`);

  const daysRaw = getArg('days') ?? '14';
  const days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`Invalid --days: ${daysRaw}`);

  const baseUrl = (getArg('base-url') ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .dev.vars, .env.local, or process env.');
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('private_sales')
    .insert({ token, product_ids: ids, expires_at: expiresAt })
    .select('id')
    .single();
  if (error) throw new Error(`Insert failed: ${error.message}`);

  const link = `${baseUrl}/koszyk?sale=${token}`;
  console.log('\nPrivate sale created.');
  console.log(`  id:        ${(data as { id: string }).id}`);
  console.log(`  pieces:    ${ids.join(', ')}`);
  console.log(`  expires:   ${expiresAt}`);
  console.log(`\n  PLN link (default /):  ${link}`);
  console.log(`  EUR link (/en):        ${baseUrl}/en/koszyk?sale=${token}`);
  console.log('\nSend the customer the PLN or EUR link. It is single-use — it stops working after a successful payment.\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
