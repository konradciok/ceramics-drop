import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminSupabase } from '@/lib/admin/clients';
import { printPricingConfigSchema } from '@/lib/print-pricing-config/schema';
import { readPrintPricingConfig } from '@/lib/print-pricing-config/repository';
import type { PrintPricingConfig } from '@/lib/print-pricing';
import { buildPricingFields } from '@/server/cms-api/pricing-mapping';
import { actorEmail, parseJson } from '@/lib/admin/product-routes';
import { supabaseTimeout } from '@/lib/supabase-timeout';

export const dynamic = 'force-dynamic';

/** Map thrown repository errors to HTTP responses (mirror of productError). */
function pricingError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'print_pricing_missing') {
    return NextResponse.json({ error: message }, { status: 404 });
  }
  if (message === 'pricing_revision_conflict') {
    return NextResponse.json({ error: message }, { status: 409 });
  }
  if (message === 'pricing_invalid') {
    return NextResponse.json({ error: message }, { status: 422 });
  }
  // Keep raw DB/Supabase detail in the server log only — never leak it to the client.
  console.error('[admin/print-pricing] pricing write failed', error);
  return NextResponse.json({ error: 'pricing_write_failed' }, { status: 500 });
}

/**
 * Translate an RPC error into the wire-level error strings this route (and the
 * admin UI's ERROR_MAP) already understand. `pricing_config_missing` is the
 * RPCs' name for exactly the condition the legacy repository called
 * `print_pricing_missing`, so it keeps that name here.
 */
function mapRpcError(error: { message?: string }): Error {
  const message = error.message ?? '';
  if (message.includes('pricing_config_missing')) return new Error('print_pricing_missing');
  if (message.includes('revision_conflict')) return new Error('pricing_revision_conflict');
  // Should be unreachable: printPricingConfigSchema has already validated the
  // body against the same ranges publish_pricing_revision re-checks.
  if (message.includes('pricing_invalid')) return new Error('pricing_invalid');
  return new Error(`publish print pricing: ${message}`);
}

/**
 * CmsApi pricing cutover, plan step 8: this route no longer writes
 * print_pricing_config directly (it used the repository's unversioned
 * `updatePrintPricingConfig`, i.e. `.update().eq('id', true)` plus an
 * after-the-fact audit row). It now goes through exactly the two RPCs the
 * CmsApi's PUT /v1/pricing/{id} and POST /v1/pricing/{id}/publication use —
 * save_pricing_draft then publish_pricing_revision
 * (supabase/migrations/20260917140000_cms_api_pricing.sql).
 *
 * That closes the two-writer window the plan warns about. A direct write left
 * print_pricing_config.published_revision pointing at a draft whose values
 * were no longer the live ones, so the CMS would show one price list while
 * checkout charged another. Routing through the RPCs means every write — from
 * either surface — produces a draft revision, an audit row, and a
 * published_revision that matches the values actually in the row.
 *
 * The request/response contract is unchanged (nested PrintPricingConfig in,
 * {config} out) so any remaining caller keeps working; only the persistence
 * path underneath moved. The admin panel itself is read-only as of step 7 and
 * no longer calls this at all.
 *
 * save-then-publish is two RPC calls, not one transaction: a failure between
 * them leaves a saved-but-unpublished draft, which is a benign, visible state
 * (the CMS shows revision > publishedRevision) and is exactly what happens when
 * an operator saves and then closes the tab. It never leaves the live row torn
 * — publish_pricing_revision's own UPDATE is atomic.
 */
async function publishPrintPricingConfig(
  supabase: SupabaseClient,
  input: PrintPricingConfig,
  actor: string | null,
): Promise<PrintPricingConfig> {
  const latest = await supabase
    .from('pricing_config_drafts')
    .select('revision')
    .order('revision', { ascending: false })
    .limit(1)
    .abortSignal(supabaseTimeout())
    .maybeSingle();
  if (latest.error) throw new Error(`load pricing revision: ${latest.error.message}`);
  const currentRevision = (latest.data as { revision: number } | null)?.revision ?? 0;

  const saved = await supabase.rpc('save_pricing_draft', {
    p_expected_revision: currentRevision,
    p_payload: { fields: buildPricingFields(input) },
    p_actor_email: actor,
  });
  if (saved.error) throw mapRpcError(saved.error);

  const published = await supabase.rpc('publish_pricing_revision', {
    p_expected_revision: currentRevision + 1,
    p_actor_email: actor,
  });
  if (published.error) throw mapRpcError(published.error);

  return readPrintPricingConfig(supabase);
}

/**
 * Replace the global fine-art-print price list (single `print_pricing_config`
 * row). Gated by the Cloudflare Access JWT in worker.ts (^/api/admin). The
 * storefront reads the row via getPrintPricingConfig() in CATALOG_SOURCE=db
 * mode; `code` mode (local/test) keeps using DEFAULT_PRINT_PRICING.
 */
export async function POST(req: Request) {
  const parsed = await parseJson(req, printPricingConfigSchema);
  if (!parsed.ok) return parsed.res;
  try {
    const config = await publishPrintPricingConfig(adminSupabase(), parsed.data, actorEmail(req));
    return NextResponse.json({ config });
  } catch (err) {
    return pricingError(err);
  }
}
