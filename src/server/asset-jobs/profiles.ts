/**
 * Worker-side planning for Priority 8 / Phase 3: turn "a confirmed upload for
 * product X at ratio R" into "the exact list of derivative profiles the
 * Container must render".
 *
 * Pure catalogue logic + one Supabase read. NO Sharp, NO container calls — this
 * runs inside the Workers queue consumer, so every helper here must stay
 * importable by `worker.ts`'s bundle. The pixel work lives behind the container
 * boundary (container/server.ts).
 *
 * Mirrors scripts/lib/db-variants.ts's `activeVariantDimensions` — the CLI's
 * equivalent read — with two deliberate differences, both fail-closed:
 *   1. NO `PRODIGI_SKU_MAP` fallback for a variant whose `print_area_*_px` is
 *      still null. The CLI has an operator in the loop who can react to a
 *      "seed it or add the SKU" message; an unattended queue consumer does not,
 *      and silently taking a code-registry dimension for a DB row the publish
 *      RPC will later compare against `product_variants.print_area_*_px`
 *      (which is what `publish_print_asset_revision` actually checks) would
 *      stage assets that can never be published. Missing pixels are therefore a
 *      terminal, operator-actionable error here.
 *   2. It never imports from `scripts/` — that tree pulls in `node:fs` /
 *      `node:child_process` through its Wrangler-CLI helpers, which must never
 *      reach Worker-bundled code (same hazard uploads-mapping.ts documents).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  distinctProfiles,
  ratioForProfile,
  type DerivativeProfile,
  type PrintRatio,
  type VariantDimension,
  PRINT_RATIOS,
} from '@/lib/print-assets-prepare';
import { MOUNT_TEMPORARILY_DISABLED } from '@/lib/print-availability';

/**
 * The `print_fulfilment_assets.revision` label a CMS-pipeline upload's
 * derivatives are staged under. Deterministic in the upload id so a retried
 * job re-derives the SAME revision (and therefore the same content-addressed
 * r2_key) instead of stranding a half-populated revision behind.
 *
 * ⚠️ KNOWN LIMITATION (see the task report): a revision is per-UPLOAD, but
 * `publish_print_asset_revision` requires ONE revision to cover EVERY active
 * variant of the product. A product whose active variants span more than one
 * print ratio needs one upload per ratio, and those uploads produce DIFFERENT
 * revisions — so such a product cannot be published from CMS uploads alone
 * until a product-scoped revision concept exists. Single-ratio products
 * publish fine. Nothing here silently papers over that: the shortfall shows up
 * as an `assignment_mismatch` from the publish RPC, not as a wrong asset.
 */
export function assetRevisionForUpload(uploadId: string): string {
  return `cms-${uploadId}`;
}

export function isPrintRatio(value: string): value is PrintRatio {
  return (PRINT_RATIOS as readonly string[]).includes(value);
}

export type VariantLoadResult =
  | { kind: 'ok'; variants: VariantDimension[] }
  | { kind: 'invalid'; message: string };

type VariantRow = {
  variant_key: string;
  print_area_width_px: number | null;
  print_area_height_px: number | null;
};

/**
 * Active print variants for a product, with their print-area pixels.
 * Returns `invalid` (→ failed_action_required) for every condition that would
 * under- or over-produce derivatives; throws only on a transient DB error
 * (→ the caller rethrows and the queue retries).
 */
export async function loadActivePrintVariants(
  supabase: SupabaseClient,
  productId: string,
): Promise<VariantLoadResult> {
  const product = await supabase.from('products').select('status').eq('id', productId).maybeSingle();
  if (product.error) throw product.error;
  if (!product.data) return { kind: 'invalid', message: `unknown product "${productId}" — no row in products` };
  const status = (product.data as { status: string }).status;
  if (status !== 'active') {
    return {
      kind: 'invalid',
      message: `product "${productId}" is not active (status="${status}") — refusing to stage derivatives for a draft/hidden/archived product`,
    };
  }

  const variants = await supabase
    .from('product_variants')
    .select('variant_key, print_area_width_px, print_area_height_px')
    .eq('product_id', productId)
    .eq('active', true);
  if (variants.error) throw variants.error;

  let rows = (variants.data ?? []) as VariantRow[];
  // Passe-partout is temporarily unsellable (src/lib/print-availability.ts) but
  // its DB rows stay active — same filter scripts/lib/db-variants.ts applies,
  // for the same reason: otherwise we stage CFPM derivatives nothing can be
  // ordered against, and publish would then require them.
  // `variant_key` = size:framed:mount:frameColour.
  if (MOUNT_TEMPORARILY_DISABLED) {
    rows = rows.filter((row) => row.variant_key.split(':')[2] !== 'true');
  }
  if (rows.length === 0) {
    return { kind: 'invalid', message: `product "${productId}" has no active print variants` };
  }

  const missing: string[] = [];
  const out: VariantDimension[] = [];
  for (const row of rows) {
    if (row.print_area_width_px == null || row.print_area_height_px == null) {
      missing.push(row.variant_key);
      continue;
    }
    out.push({ variantKey: row.variant_key, w: row.print_area_width_px, h: row.print_area_height_px });
  }
  if (missing.length > 0) {
    return {
      kind: 'invalid',
      message:
        `active variant(s) with no seeded print_area_*_px: ${missing.join(', ')} — run the catalogue backfill ` +
        'before processing uploads for this product',
    };
  }
  return { kind: 'ok', variants: out };
}

export type ProfileSelection =
  | { kind: 'ok'; profiles: DerivativeProfile[] }
  | { kind: 'invalid'; message: string };

/**
 * The distinct derivative profiles a source at `ratio` is responsible for:
 * every active-variant dimension set whose own aspect resolves to that ratio.
 *
 * A profile whose dimensions match NO known print ratio is a hard error rather
 * than a skip — `ratioForProfile` fails closed by design, and silently dropping
 * such a profile would stage an incomplete revision that publish then rejects
 * with a much less informative `assignment_mismatch`.
 */
export function selectProfilesForRatio(variants: VariantDimension[], ratio: PrintRatio): ProfileSelection {
  const profiles = distinctProfiles(variants);
  const matching: DerivativeProfile[] = [];
  for (const profile of profiles) {
    let profileRatio: PrintRatio;
    try {
      profileRatio = ratioForProfile(profile.w, profile.h);
    } catch (e) {
      return { kind: 'invalid', message: e instanceof Error ? e.message : String(e) };
    }
    if (profileRatio === ratio) matching.push(profile);
  }
  if (matching.length === 0) {
    return {
      kind: 'invalid',
      message: `no active variant of this product needs ratio "${ratio}" (profiles: ${profiles.map((p) => p.profileKey).join(', ')})`,
    };
  }
  return { kind: 'ok', profiles: matching };
}
