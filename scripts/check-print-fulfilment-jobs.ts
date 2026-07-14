/**
 * Read-only Phase 0 gate: list non-terminal Prodigi fulfilment jobs.
 *
 * Run before changing print-asset key semantics. Exits non-zero when any
 * print order still has an in-flight fulfilment_jobs row.
 *
 *   npm run print-fulfilment:check-jobs [-- --json]
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.dev.vars / .env.local).
 */
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnv } from './lib/script-env';

const TERMINAL = new Set(['completed', 'shipped', 'cancelled', 'failed_action_required']);

// ponytail: normalised onto the shared script-env loader. Previously this script
// resolved env with an inverted file order (.env.local overrode .dev.vars) and a
// parser that did not strip surrounding quotes — both now follow the canonical
// helper precedence (.env.local < .dev.vars < --env-file < process.env), matching
// every other script. Only matters if both dotfiles define conflicting
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY values.
function loadEnv(): { url: string; key: string } {
  const env = loadLocalEnv();
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }
  return { url, key };
}

async function main(): Promise<void> {
  const jsonOut = process.argv.includes('--json');
  const { url, key } = loadEnv();
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: printOrders, error: ordersError } = await supabase
    .from('orders')
    .select('id')
    .eq('fulfilment_type', 'prodigi');

  if (ordersError) throw new Error(`orders query failed: ${ordersError.message}`);

  const orderIds = (printOrders ?? []).map((o) => o.id);
  if (orderIds.length === 0) {
    const empty = { checkedAt: new Date().toISOString(), terminalStatuses: [...TERMINAL], inflight: [] as unknown[] };
    if (jsonOut) console.log(JSON.stringify(empty, null, 2));
    else console.log('No prodigi orders — no in-flight print fulfilment jobs.');
    return;
  }

  const { data, error } = await supabase
    .from('fulfilment_jobs')
    .select('id, order_id, status, attempts, updated_at')
    .in('order_id', orderIds);

  if (error) throw new Error(`fulfilment_jobs query failed: ${error.message}`);

  const inflight = (data ?? []).filter((row) => !TERMINAL.has(row.status as string));

  const report = {
    checkedAt: new Date().toISOString(),
    terminalStatuses: [...TERMINAL],
    inflight: inflight.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      status: row.status,
      attempts: row.attempts,
      updatedAt: row.updated_at,
    })),
  };

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else if (inflight.length === 0) {
    console.log('No in-flight print fulfilment jobs.');
  } else {
    console.log(`${inflight.length} in-flight print fulfilment job(s):`);
    for (const row of report.inflight) {
      console.log(`  ${row.id}  order=${row.orderId}  status=${row.status}  updated=${row.updatedAt}`);
    }
  }

  if (inflight.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
