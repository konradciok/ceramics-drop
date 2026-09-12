import type { SupabaseClient } from '@supabase/supabase-js';
import { signPrintAssetUrl } from '@/lib/print-assets';
import type { CategorySlug, PrintFrameColour, PrintSize } from '@/lib/types';
import type { CeramicDraft, PrintDraft, ProductDraft, ProductResponse, Proof } from './types';

type ProductRow = {
  id: string;
  type: 'ceramic' | 'print';
  category_slug: string;
  num: string;
  measure: string;
  price_pln: number | null;
  price_eur: number | null;
  price_gbp: number | null;
  drop_id: string | null;
  status: 'draft' | 'active' | 'hidden' | 'archived';
  published_revision: number | null;
};

type VariantRow = { product_id: string; variant_key: string; axes: unknown; active: boolean };
type MediaRow = { product_id: string; url: string; is_primary: boolean };
type PieceRow = { product_id: string; status: string; reserved_until: string | null; showroom: boolean };

export async function loadProductResponses(
  supabase: SupabaseClient,
  env: Pick<CloudflareEnv, 'PRINT_ASSET_TOKEN_SECRET'>,
  productIds: string[],
): Promise<Map<string, ProductResponse>> {
  if (productIds.length === 0) return new Map();

  const [productsRes, draftsRes, variantsRes, mediaRes, piecesRes] = await Promise.all([
    supabase.from('products').select('id, type, category_slug, num, measure, price_pln, price_eur, price_gbp, drop_id, status, published_revision').in('id', productIds),
    supabase.from('product_drafts').select('product_id, revision, payload').in('product_id', productIds).order('revision', { ascending: false }),
    supabase.from('product_variants').select('product_id, variant_key, axes, active').in('product_id', productIds),
    supabase.from('product_media').select('product_id, url, is_primary').in('product_id', productIds).order('position', { ascending: true }),
    supabase.from('piece_state').select('product_id, status, reserved_until, showroom').in('product_id', productIds),
  ]);

  for (const res of [productsRes, draftsRes, variantsRes, mediaRes, piecesRes]) {
    if (res.error) throw res.error;
  }

  const products = (productsRes.data ?? []) as ProductRow[];
  const variantsByProduct = groupBy((variantsRes.data ?? []) as VariantRow[], (v) => v.product_id);
  const mediaByProduct = groupBy((mediaRes.data ?? []) as MediaRow[], (m) => m.product_id);
  const pieceByProduct = new Map(((piecesRes.data ?? []) as PieceRow[]).map((p) => [p.product_id, p]));

  const latestDraftByProduct = new Map<string, { revision: number; payload: ProductDraft }>();
  for (const row of (draftsRes.data ?? []) as { product_id: string; revision: number; payload: ProductDraft }[]) {
    if (!latestDraftByProduct.has(row.product_id)) {
      latestDraftByProduct.set(row.product_id, { revision: row.revision, payload: row.payload });
    }
  }

  const printIds = products.filter((p) => p.type === 'print').map((p) => p.id);
  const proofsByProduct = await loadProofsForProducts(supabase, env, printIds);

  const result = new Map<string, ProductResponse>();
  for (const product of products) {
    const draftEntry = latestDraftByProduct.get(product.id);
    const revision = draftEntry?.revision ?? 0;
    const draft = draftEntry?.payload ?? synthesizeDraft(product, variantsByProduct.get(product.id) ?? [], mediaByProduct.get(product.id) ?? []);
    const publishedRevision = product.published_revision ?? (!draftEntry && product.status === 'active' ? 0 : null);

    const availability =
      product.type === 'print' ? 'available' : deriveCeramicAvailability(pieceByProduct.get(product.id));

    result.set(product.id, {
      id: product.id,
      type: product.type,
      revision,
      publishedRevision,
      status: product.status,
      draft,
      thumbnail: draft.images[0],
      proofs: proofsByProduct.get(product.id) ?? [],
      availability,
    });
  }
  return result;
}

export async function loadProductResponse(
  supabase: SupabaseClient,
  env: Pick<CloudflareEnv, 'PRINT_ASSET_TOKEN_SECRET'>,
  productId: string,
): Promise<ProductResponse | null> {
  const map = await loadProductResponses(supabase, env, [productId]);
  return map.get(productId) ?? null;
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k) ?? [];
    list.push(row);
    map.set(k, list);
  }
  return map;
}

function deriveCeramicAvailability(piece?: PieceRow): ProductResponse['availability'] {
  if (!piece) return 'available';
  if (piece.showroom) return 'showroom';
  if (piece.status === 'sold') return 'sold';
  if (piece.status === 'reserved' && piece.reserved_until && new Date(piece.reserved_until) > new Date()) return 'reserved';
  return 'available';
}

const PLACEHOLDER_IMAGE = 'https://anna-ciok.studio/uploads/placeholder.webp';

function synthesizeDraft(product: ProductRow, variants: VariantRow[], media: MediaRow[]): ProductDraft {
  const sortedMedia = [...media].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  const images = sortedMedia.length > 0 ? sortedMedia.map((m) => m.url) : [PLACEHOLDER_IMAGE];

  if (product.type === 'print') {
    const axes = variants
      .filter((v) => v.active)
      .map((v) => v.axes as { size: PrintSize; framed: boolean; mount: boolean; frameColour: PrintFrameColour | 'none' } | null)
      .filter((a): a is NonNullable<typeof a> => Boolean(a));

    const sizes = Array.from(new Set(axes.map((a) => a.size)));
    const frameColours = Array.from(new Set(axes.filter((a) => a.framed && a.frameColour !== 'none').map((a) => a.frameColour as PrintFrameColour)));
    const mountAvailable = axes.some((a) => a.mount);

    const printDraft: PrintDraft = {
      type: 'print',
      displayNumber: product.num,
      sizes: sizes.length > 0 ? sizes : ['30x40'],
      frameColours,
      mountAvailable,
      unavailable: [],
      images,
      title: { pl: `Fine art print ${product.num}` },
      description: { pl: '' },
      seo: {},
    };
    return printDraft;
  }

  const ceramicDraft: CeramicDraft = {
    type: 'ceramic',
    category: product.category_slug as CategorySlug,
    displayNumber: product.num,
    measure: product.measure ?? '',
    pricePln: (product.price_pln ?? 0) * 100,
    priceEur: (product.price_eur ?? 0) * 100,
    priceGbp: (product.price_gbp ?? 0) * 100,
    images,
    title: { pl: `${product.category_slug} ${product.num}` },
    description: { pl: '' },
    seo: {},
    showroom: false,
  };
  return ceramicDraft;
}

type AssetRow = { id: string; product_id: string; revision: string; status: string; profile_key: string | null };
type AssignmentRow = { product_id: string; variant_key: string; asset_id: string };

async function loadProofsForProducts(
  supabase: SupabaseClient,
  env: Pick<CloudflareEnv, 'PRINT_ASSET_TOKEN_SECRET'>,
  printIds: string[],
): Promise<Map<string, Proof[]>> {
  const map = new Map<string, Proof[]>();
  if (printIds.length === 0) return map;

  const [assignRes, assetsRes] = await Promise.all([
    supabase.from('print_variant_asset_assignments').select('product_id, variant_key, asset_id').in('product_id', printIds),
    supabase
      .from('print_fulfilment_assets')
      .select('id, product_id, revision, status, profile_key')
      .in('product_id', printIds)
      .order('created_at', { ascending: false }),
  ]);
  if (assignRes.error) throw assignRes.error;
  if (assetsRes.error) throw assetsRes.error;

  const variantKeyByAssetId = new Map(((assignRes.data ?? []) as AssignmentRow[]).map((a) => [a.asset_id, a.variant_key]));

  for (const asset of (assetsRes.data ?? []) as AssetRow[]) {
    const list = map.get(asset.product_id) ?? [];
    // A `staged` asset has no assignment yet (assignment only happens on
    // publish_print_asset_revision, which requires status='ready') — its
    // profile_key (a dimension label, e.g. '3600x4800') stands in as a
    // best-effort variant hint until it is assigned. See
    // docs/cms-api-data-model.md for this S1/S3 boundary note.
    const variantKey = variantKeyByAssetId.get(asset.id) ?? asset.profile_key ?? '';
    // resolveAssetR2Key (src/server/print-assets/repository.ts) only serves
    // ready|retired assets — a staged proof has no live preview URL in S1.
    const url =
      asset.status === 'ready' || asset.status === 'retired'
        ? env.PRINT_ASSET_TOKEN_SECRET
          ? await signPrintAssetUrl(asset.id, env.PRINT_ASSET_TOKEN_SECRET)
          : null
        : null;
    list.push({ id: asset.id, variantKey, revision: asset.revision, status: asset.status as Proof['status'], url });
    map.set(asset.product_id, list);
  }
  return map;
}
