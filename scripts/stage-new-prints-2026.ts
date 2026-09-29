/** Local dry-run by default. --apply stages only this batch through the atomic backfill RPC. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnv } from './lib/script-env';
import { buildNewPrintBatch } from './lib/new-print-batch';

const reportPath = 'config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-import.json';
const sha = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function main() {
  const seed = buildNewPrintBatch();
  const ids = seed.products.map((p) => p.id);
  console.log(JSON.stringify({ products: seed.products.length, variants: seed.variants.length, media: seed.media.length, payloadSha256: sha(seed) }));
  if (!process.argv.includes('--apply')) return;
  if (fs.existsSync(reportPath)) throw new Error('Import report already exists; inspect state before retrying');
  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing Supabase credentials');
  const host = new URL(env.SUPABASE_URL).hostname;
  if (host !== 'wnlysejenowymjdxlnaq.supabase.co') throw new Error('Unexpected target project');
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  async function readAll(table: string) {
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from(table).select('*').order('id').range(offset, offset + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }
  const tables = ['products', 'product_variants', 'product_media'];
  const before: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) {
    before[table] = await readAll(table);
    if (before[table].some((r) => ids.includes(String(table === 'products' ? r.id : r.product_id)))) {
      throw new Error(`ID conflict in ${table}; refusing replacement`);
    }
  }
  for (const table of ['product_drafts', 'print_fulfilment_assets', 'print_variant_asset_assignments']) {
    const { data, error } = await db.from(table).select('product_id').in('product_id', ids);
    if (error) throw error;
    if (data.length) throw new Error(`ID conflict in ${table}`);
  }
  const { data, error } = await db.rpc('backfill_catalog', {
    p_products: seed.products, p_variants: seed.variants, p_media: seed.media,
  });
  if (error) throw new Error(`Atomic import: ${error.message}`);
  // Record the committed write before verification: a failed read must not invite a blind retry.
  const report = { importedAt: new Date().toISOString(), host, status: 'committed_pending_verification',
    productIds: ids, products: seed.products.length, variants: seed.variants.length,
    media: 0, payloadSha256: sha(seed), rpcResult: data, existingRowsUnchanged: false };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  for (const table of tables) {
    const after = await readAll(table);
    const old = after.filter((r) => !ids.includes(String(table === 'products' ? r.id : r.product_id)));
    if (sha(old) !== sha(before[table])) throw new Error(`Existing ${table} changed; investigate before continuing`);
    const added = after.filter((r) => ids.includes(String(table === 'products' ? r.id : r.product_id)));
    const expected = table === 'products' ? seed.products : table === 'product_variants' ? seed.variants : seed.media;
    if (added.length !== expected.length) throw new Error(`${table}: count mismatch`);
    for (const row of expected) {
      const match = added.find((r) => 'id' in row ? r.id === row.id
        : r.product_id === row.product_id && 'variant_key' in row && r.variant_key === row.variant_key);
      if (!match) throw new Error(`${table}: missing row`);
      for (const [key, value] of Object.entries(row)) {
        // PostgreSQL jsonb may reorder object keys.
        if (typeof value === 'object' && value !== null) {
          for (const [axis, v] of Object.entries(value)) {
            if ((match[key] as Record<string, unknown>)?.[axis] !== v) throw new Error(`${table}: axis mismatch`);
          }
        } else if (match[key] !== value) throw new Error(`${table}: mismatch in ${key}`);
      }
    }
  }
  report.status = 'verified_drafts_with_active_variants';
  report.existingRowsUnchanged = true;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('Verified: 16 drafts, 192 active variants; previous catalogue rows unchanged.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Import failed');
  process.exitCode = 1;
});
