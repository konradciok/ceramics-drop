/**
 * Launch an `upcoming` drop: end the current active drop and activate the new
 * one in a single transaction (`launch_drop` RPC). The storefront then lists
 * only the new batch and moves the previous one to the /showroom archive.
 * Full flow: docs/new-drop-runbook.md.
 *
 * Usage:
 *   npm run drop:launch -- --id drop-2                    # dry run: shows what would change
 *   npm run drop:launch -- --id drop-2 --confirm drop-2   # performs the switch
 *
 * Refuses to launch a drop that has no ceramic products or is missing
 * piece_state rows for any of them (the shop would open empty or with
 * unbuyable pieces). Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * (.env.local / .dev.vars / --env-file / env).
 */
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnv } from './lib/script-env';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { id: { type: 'string' }, confirm: { type: 'string' }, 'env-file': { type: 'string' } },
  });
  const id = typeof values.id === 'string' ? values.id.trim() : '';
  if (!id) throw new Error('Missing --id (the upcoming drop to launch, e.g. --id drop-2).');

  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .dev.vars, .env.local, or process env.');
  }
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const drops = await supabase.from('drops').select('id,label,status').order('created_at');
  if (drops.error) throw new Error(`drops lookup failed: ${drops.error.message}`);
  const target = drops.data.find((d) => d.id === id);
  if (!target) throw new Error(`Drop ${id} does not exist — create it with npm run drop:create.`);
  if (target.status !== 'upcoming') throw new Error(`Drop ${id} is ${target.status}, not upcoming.`);
  const active = drops.data.find((d) => d.status === 'active');

  // Scoped to the target drop (a batch is far below the 1,000-row API cap).
  const products = await supabase
    .from('products')
    .select('id')
    .eq('type', 'ceramic')
    .eq('drop_id', id)
    .eq('status', 'active');
  if (products.error) throw new Error(`products lookup failed: ${products.error.message}`);
  const newIds = products.data.map((p) => p.id);
  let activeCount = 0;
  if (active) {
    const counted = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('drop_id', active.id);
    if (counted.error) throw new Error(`products count failed: ${counted.error.message}`);
    activeCount = counted.count ?? 0;
  }

  const pieces = newIds.length
    ? await supabase.from('piece_state').select('product_id,status').in('product_id', newIds)
    : { data: [] as { product_id: string; status: string }[], error: null };
  if (pieces.error) throw new Error(`piece_state lookup failed: ${pieces.error.message}`);
  const withState = new Set(pieces.data.map((p) => p.product_id));
  const missingState = newIds.filter((pid) => !withState.has(pid));
  const available = pieces.data.filter((p) => p.status === 'available').length;

  console.log(`\nSupabase: ${new URL(env.SUPABASE_URL).host}`);
  console.log(`End:      ${active ? `${active.id} (${active.label}) — ${activeCount} pieces move to the archive` : '(no active drop)'}`);
  console.log(`Launch:   ${target.id} (${target.label}) — ${newIds.length} active pieces, ${available} available`);

  if (newIds.length === 0) throw new Error(`Drop ${id} has no active ceramic products — run npm run catalog:backfill first.`);
  if (missingState.length > 0) {
    throw new Error(`piece_state rows missing for: ${missingState.join(', ')} — merge the piece_state migration first.`);
  }

  if (values.confirm === undefined) {
    console.log(`\nDry run. To launch: npm run drop:launch -- --id ${id} --confirm ${id}\n`);
    return;
  }
  if (values.confirm !== id) throw new Error(`--confirm must equal --id (${id}).`);

  const { data, error } = await supabase.rpc('launch_drop', { p_drop_id: id });
  if (error) throw new Error(`launch_drop failed: ${error.message}`);
  console.log(`\nLaunched: ${JSON.stringify(data)}`);
  console.log('Next: bump FALLBACK_CURRENT_DROP_ID in src/lib/products.ts in a follow-up commit.\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
