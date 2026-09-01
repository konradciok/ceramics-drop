/* ============================================================
   Print pricing config repository — DB read/write for the single-row
   `print_pricing_config` table (migration 20260807120000). Callers inject
   the Supabase client (service-role); errors throw. The cached storefront
   read goes through ./load.ts + ./get.ts; the admin page/route calls these
   directly with adminSupabase() for always-fresh reads and audited writes.
   ============================================================ */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PrintPricingConfig } from '../print-pricing';
import { supabaseTimeout } from '../supabase-timeout';
import { printPricingConfigSchema } from './schema';

interface PrintPricingRow {
  base_30x40_eur: number;
  base_50x70_eur: number;
  base_70x100_eur: number;
  frame_30x40_eur: number;
  frame_50x70_eur: number;
  frame_70x100_eur: number;
  mount_30x40_eur: number;
  mount_50x70_eur: number;
  mount_70x100_eur: number;
  eur_to_pln: number | string;
  eur_to_gbp: number | string;
}

/** Map the flat DB row to the nested domain shape and validate it. */
function rowToConfig(row: PrintPricingRow): PrintPricingConfig {
  return printPricingConfigSchema.parse({
    baseEur: { '30x40': row.base_30x40_eur, '50x70': row.base_50x70_eur, '70x100': row.base_70x100_eur },
    frameEur: { '30x40': row.frame_30x40_eur, '50x70': row.frame_50x70_eur, '70x100': row.frame_70x100_eur },
    mountEur: { '30x40': row.mount_30x40_eur, '50x70': row.mount_50x70_eur, '70x100': row.mount_70x100_eur },
    // numeric columns can surface as strings depending on the driver — coerce.
    eurToPln: Number(row.eur_to_pln),
    eurToGbp: Number(row.eur_to_gbp),
  });
}

function configToRow(config: PrintPricingConfig): PrintPricingRow {
  return {
    base_30x40_eur: config.baseEur['30x40'],
    base_50x70_eur: config.baseEur['50x70'],
    base_70x100_eur: config.baseEur['70x100'],
    frame_30x40_eur: config.frameEur['30x40'],
    frame_50x70_eur: config.frameEur['50x70'],
    frame_70x100_eur: config.frameEur['70x100'],
    mount_30x40_eur: config.mountEur['30x40'],
    mount_50x70_eur: config.mountEur['50x70'],
    mount_70x100_eur: config.mountEur['70x100'],
    eur_to_pln: config.eurToPln,
    eur_to_gbp: config.eurToGbp,
  };
}

/**
 * Read the global print pricing config. Throws `print_pricing_missing` when
 * the seed row is absent (migration not applied) and on any Supabase error.
 */
export async function readPrintPricingConfig(supabase: SupabaseClient): Promise<PrintPricingConfig> {
  const res = await supabase
    .from('print_pricing_config')
    .select('*')
    .abortSignal(supabaseTimeout())
    .maybeSingle();
  if (res.error) throw new Error(`read print pricing: ${res.error.message}`);
  if (!res.data) throw new Error('print_pricing_missing');
  return rowToConfig(res.data as PrintPricingRow);
}

/** Insert an audit row; failures are logged, not fatal (the write already committed). */
async function writePricingAudit(
  supabase: SupabaseClient,
  entry: { actor_email: string | null; before: unknown; after: unknown },
): Promise<void> {
  // catalog_audit_log deliberately has no FK on product_id, so the sentinel is safe.
  const res = await supabase.from('catalog_audit_log').insert({
    product_id: 'print-pricing',
    action: 'pricing:update',
    ...entry,
  });
  if (res.error) console.error('[print-pricing] audit write failed', res.error.message);
}

/**
 * Replace the global print pricing config (the row is validated by the route's
 * Zod parse before this runs; DB check constraints back it up). Throws
 * `print_pricing_missing` when the seed row is absent.
 */
export async function updatePrintPricingConfig(
  supabase: SupabaseClient,
  input: PrintPricingConfig,
  actorEmail: string | null,
): Promise<PrintPricingConfig> {
  const before = await supabase.from('print_pricing_config').select('*').maybeSingle();
  if (before.error) throw new Error(`load print pricing: ${before.error.message}`);
  if (!before.data) throw new Error('print_pricing_missing');

  const res = await supabase
    .from('print_pricing_config')
    .update({
      ...configToRow(input),
      updated_at: new Date().toISOString(),
      updated_by: actorEmail,
    })
    .eq('id', true)
    .select('*')
    .maybeSingle();
  if (res.error) throw new Error(`update print pricing: ${res.error.message}`);
  if (!res.data) throw new Error('print_pricing_missing');

  await writePricingAudit(supabase, {
    actor_email: actorEmail,
    before: before.data,
    after: res.data,
  });
  return rowToConfig(res.data as PrintPricingRow);
}
