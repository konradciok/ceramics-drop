import type { SupabaseClient } from '@supabase/supabase-js';
import { signPrintAssetUrl } from '@/lib/print-assets';
import type { AssetResponse } from './types';

// ---------------------------------------------------------------------------
// GET /v1/assets — reads the ALREADY-WORKING print_fulfilment_assets table
// (supabase/migrations/20260711120000_print_fulfilment_assets.sql). Read-only:
// this handler never writes to that table (publishing/proof-approval already
// own that — see mapping.ts's loadProofsForProducts / publication.ts).
//
// print_fulfilment_assets predates contracts/cms-v1.json's Asset schema and
// was designed for a different (print-fulfilment) purpose, so several fields
// don't line up 1:1 — documented at each mapping decision below rather than
// forcing a fictitious precision:
//   - only status IN ('ready', 'retired') is listed. `staged` is excluded
//     because Asset.url is a REQUIRED non-null string and a staged asset has
//     no servable URL yet (see mapping.ts's loadProofsForProducts, which
//     signs a URL only for ready/retired for the identical reason);
//     `revoked` is excluded because it is functionally deleted (repository.ts
//     never serves it either). Both map to Asset.status 'ready' — the
//     contract's uploaded/processing/ready/failed vocabulary describes the
//     NEW upload pipeline's lifecycle (Task 9), not this table's richer
//     staged/ready/retired/revoked one; 'ready' is the only value of the four
//     that is actually true of a listed row.
//   - Asset.revision (contract: integer) has no real counterpart here —
//     print_fulfilment_assets.revision is a free-text print-revision label
//     (e.g. "2026-07-11-r1", see scripts/print-assets-upload.ts), not a
//     numeric optimistic-concurrency counter, and this listing is read-only
//     (no CAS is ever performed against these rows through this endpoint), so
//     the field carries no real meaning here — it is always 0. The free-text
//     label is preserved, human-readably, in `name` instead.
//   - Asset.ratio (contract: required string) has no stored column; computed
//     from width_px/height_px via computeAssetRatio.
// ---------------------------------------------------------------------------

type PrintFulfilmentAssetRow = {
  id: string;
  product_id: string;
  revision: string;
  profile_key: string | null;
  status: 'staged' | 'ready' | 'retired' | 'revoked';
  width_px: number;
  height_px: number;
};

const LISTED_STATUSES = ['ready', 'retired'] as const;

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** width/height reduced to lowest terms, e.g. (3600, 4800) -> "3:4". */
export function computeAssetRatio(widthPx: number, heightPx: number): string {
  const divisor = gcd(widthPx, heightPx) || 1;
  return `${widthPx / divisor}:${heightPx / divisor}`;
}

/** "{productId} · {print revision label}[ · {profileKey}]" — see the module comment on Asset.revision. */
export function buildAssetName(row: Pick<PrintFulfilmentAssetRow, 'product_id' | 'revision' | 'profile_key'>): string {
  return row.profile_key ? `${row.product_id} · ${row.revision} · ${row.profile_key}` : `${row.product_id} · ${row.revision}`;
}

export function mapPrintFulfilmentAssetToAsset(
  row: Pick<PrintFulfilmentAssetRow, 'id' | 'product_id' | 'revision' | 'profile_key' | 'width_px' | 'height_px'>,
  url: string,
  usages: string[],
): AssetResponse {
  return {
    id: row.id,
    name: buildAssetName(row),
    revision: 0,
    status: 'ready',
    ratio: computeAssetRatio(row.width_px, row.height_px),
    url,
    usages,
    error: '',
  };
}

// ---------------------------------------------------------------------------
// I/O — always over the handler context's ctx.supabase / env, never
// adminSupabase() / getCloudflareContext() (see request-handler.test.ts's
// Task 5 regression).
// ---------------------------------------------------------------------------

type AssignmentRow = { product_id: string; variant_key: string; asset_id: string };

export async function loadAssetList(
  supabase: SupabaseClient,
  env: Pick<CloudflareEnv, 'PRINT_ASSET_TOKEN_SECRET'>,
): Promise<AssetResponse[]> {
  const [assetsRes, assignRes] = await Promise.all([
    supabase
      .from('print_fulfilment_assets')
      .select('id, product_id, revision, profile_key, status, width_px, height_px')
      .in('status', LISTED_STATUSES)
      .order('created_at', { ascending: false }),
    supabase.from('print_variant_asset_assignments').select('product_id, variant_key, asset_id'),
  ]);
  if (assetsRes.error) throw assetsRes.error;
  if (assignRes.error) throw assignRes.error;

  const usagesByAsset = new Map<string, string[]>();
  for (const a of (assignRes.data ?? []) as AssignmentRow[]) {
    const list = usagesByAsset.get(a.asset_id) ?? [];
    list.push(`${a.product_id}:${a.variant_key}`);
    usagesByAsset.set(a.asset_id, list);
  }

  const rows = (assetsRes.data ?? []) as PrintFulfilmentAssetRow[];
  return Promise.all(
    rows.map(async (row) => {
      const url = await signPrintAssetUrl(row.id, env.PRINT_ASSET_TOKEN_SECRET);
      return mapPrintFulfilmentAssetToAsset(row, url, usagesByAsset.get(row.id) ?? []);
    }),
  );
}
