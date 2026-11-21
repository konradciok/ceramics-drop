import type { SupabaseClient } from '@supabase/supabase-js';
import type { CategorySlug, PrintFrameColour, PrintSize } from '@/lib/types';
import { CATEGORY_SLUGS } from './validation';
import type { CeramicDraft, PrintDraft, ProductDraft, ProductResponse } from './types';

// Same source of truth ceramicDraftSchema uses for its category enum — reused
// here (rather than a fresh list) so the mapper and the write-path validator
// can never drift apart on what counts as a valid ceramic category.
function isCeramicCategorySlug(slug: string): slug is Exclude<CategorySlug, 'fine-art-prints'> {
  return (CATEGORY_SLUGS as readonly string[]).includes(slug);
}

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
      // Print fulfilment proofs went with the print-asset pipeline (2026-11);
      // the field stays in the contract shape, always empty.
      proofs: [],
      availability,
    });
  }
  return result;
}

export async function loadProductResponse(
  supabase: SupabaseClient,
  productId: string,
): Promise<ProductResponse | null> {
  const map = await loadProductResponses(supabase, [productId]);
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

  // products.category_slug is only `text not null` — no DB constraint ties it
  // to type='ceramic'. Reject a corrupt/legacy row here instead of silently
  // returning a CeramicDraft whose `category` lies about its declared type.
  if (!isCeramicCategorySlug(product.category_slug)) {
    throw new Error(
      `Product ${product.id} has type='ceramic' but category_slug='${product.category_slug}' is not a valid ceramic category.`,
    );
  }

  const ceramicDraft: CeramicDraft = {
    type: 'ceramic',
    category: product.category_slug,
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

