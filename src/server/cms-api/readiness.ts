import type { SupabaseClient } from '@supabase/supabase-js';
import { variantKey, PRODIGI_SKU_MAP } from '@/lib/print-cart';
import type { PrintFrameColour } from '@/lib/types';
import type { PrintDraft, ProductResponse } from './types';

export type PrintVariantSpec = {
  variant_key: string;
  sku: string | null;
  print_area_width_px: number | null;
  print_area_height_px: number | null;
};

export type ReadinessResult = { revision: number; ready: boolean; blockers: string[]; warnings: string[] };

export function buildPrintVariantSpecs(draft: PrintDraft): PrintVariantSpec[] {
  const specs: PrintVariantSpec[] = [];
  const unavailable = new Set(draft.unavailable ?? []);

  const push = (sel: { size: PrintDraft['sizes'][number]; framed: boolean; mount: boolean; frameColour: PrintFrameColour | 'none' }) => {
    const key = variantKey(sel);
    if (unavailable.has(key)) return;
    const entry = PRODIGI_SKU_MAP[key];
    specs.push({
      variant_key: key,
      sku: entry?.sku ?? null,
      print_area_width_px: entry?.printAreaPx.w ?? null,
      print_area_height_px: entry?.printAreaPx.h ?? null,
    });
  };

  for (const size of draft.sizes) {
    push({ size, framed: false, mount: false, frameColour: 'none' });
    for (const frameColour of draft.frameColours ?? []) {
      push({ size, framed: true, mount: false, frameColour });
      if (draft.mountAvailable) {
        push({ size, framed: true, mount: true, frameColour });
      }
    }
  }
  return specs;
}

type AssetRow = { id: string; status: string; width_px: number; height_px: number };
type AssignmentRow = { variant_key: string; asset_id: string };

export async function computeReadiness(supabase: SupabaseClient, product: ProductResponse): Promise<ReadinessResult> {
  const warnings: string[] = [];
  const { title } = product.draft;
  if (!title.en && !title.es && !title.de) {
    warnings.push('Brak EN, ES lub DE: sklep użyje treści PL.');
  }

  if (product.draft.type === 'ceramic') {
    return { revision: product.revision, ready: true, blockers: [], warnings };
  }

  const specs = buildPrintVariantSpecs(product.draft);
  const blockers: string[] = [];

  const [assignRes, assetsRes] = await Promise.all([
    supabase.from('print_variant_asset_assignments').select('variant_key, asset_id').eq('product_id', product.id),
    supabase.from('print_fulfilment_assets').select('id, status, width_px, height_px').eq('product_id', product.id),
  ]);
  if (assignRes.error) throw assignRes.error;
  if (assetsRes.error) throw assetsRes.error;

  const assetById = new Map(((assetsRes.data ?? []) as AssetRow[]).map((a) => [a.id, a]));
  const assignmentByVariant = new Map(((assignRes.data ?? []) as AssignmentRow[]).map((a) => [a.variant_key, a.asset_id]));

  for (const spec of specs) {
    const assetId = assignmentByVariant.get(spec.variant_key);
    const asset = assetId ? assetById.get(assetId) : undefined;
    const dimensionsMatch = Boolean(
      asset && spec.print_area_width_px === asset.width_px && spec.print_area_height_px === asset.height_px,
    );
    if (!asset || asset.status !== 'ready' || !dimensionsMatch) {
      blockers.push(`Zaakceptuj proof dla wariantu ${spec.variant_key}.`);
    }
  }

  return { revision: product.revision, ready: blockers.length === 0, blockers, warnings };
}
