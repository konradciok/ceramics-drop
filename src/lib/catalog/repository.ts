/* ============================================================
   Catalog repository — DB read/write for the product catalogue
   ------------------------------------------------------------
   Production reads these tables when CATALOG_SOURCE=db. The backfill is a
   structural sync; print publication state is staged/preserved separately and
   every inactive -> active transition is guarded in Postgres.
   ============================================================ */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PrintDesign, Product } from '../types';
import { supabaseTimeout } from '../supabase-timeout';
import { buildCatalogSeed } from './seed';
import { mapCeramicProducts, mapPrintDesigns, sortCeramicProductRows } from './mappers';
import { parseProductRow, parseProductRows } from './read-schemas';
import type { MediaSeedRow, ProductSeedRow, ProductStatus, VariantSeedRow } from './types';
import type { ProductUpdateInput } from './schemas';

/** The catalogue rows the admin list reads (products + their variants). */
export interface CatalogRows {
  products: ProductSeedRow[];
  variants: VariantSeedRow[];
}

/**
 * Read every catalogue product + variant row. Returns empty arrays when the
 * shadow tables have not been backfilled yet — callers fall back to the code
 * registry and surface a "run catalog:backfill" hint.
 */
export async function listCatalogRows(supabase: SupabaseClient): Promise<CatalogRows> {
  const [productsRes, variantsRes] = await Promise.all([
    supabase.from('products').select('*'),
    supabase.from('product_variants').select('*'),
  ]);
  if (productsRes.error) throw new Error(`list products: ${productsRes.error.message}`);
  if (variantsRes.error) throw new Error(`list variants: ${variantsRes.error.message}`);
  // Admin-only reader: validate + report a bad row (Sentry) but do NOT withhold
  // it — see read-schemas.ts's parseProductRow doc comment for why. Dropping a
  // row here would shrink dbRows.products.length below the registry count and
  // trip listProducts()'s completeness fallback (catalog-list.ts), hiding the
  // ENTIRE admin product list behind the stale registry over one bad row.
  const rawProducts = (productsRes.data ?? []) as ProductSeedRow[];
  for (const row of rawProducts) parseProductRow(row);
  return {
    products: rawProducts,
    variants: (variantsRes.data ?? []) as VariantSeedRow[],
  };
}

/**
 * Idempotently mirror the code registry into the catalog tables.
 *
 * `backfill_catalog()` owns the complete operation in one PostgreSQL transaction.
 * Product ids are never deleted (historical order_items may reference them),
 * while variants and media are replaced for the seeded ids so partial unique
 * indexes converge cleanly. Any failed insert/readiness check rolls every
 * product, variant, and media mutation back together.
 *
 * Publication remains fail-closed inside the RPC: new registry-active prints
 * are drafted, existing registry-active prints preserve their DB status, and
 * every preserved active print is rechecked after variant replacement. This
 * does NOT touch piece_state or orders — stock and sale state stay in their
 * dedicated tables.
 *
 * Requires migration 20260828120000 (atomic RPC/publication guard) plus
 * 20260709130000 (the `drop-1` row referenced by ceramic product rows).
 */
export async function backfillCatalog(supabase: SupabaseClient): Promise<void> {
  const seed = buildCatalogSeed();
  const { error } = await supabase.rpc('backfill_catalog', {
    p_products: seed.products,
    p_variants: seed.variants,
    p_media: seed.media,
  });
  if (error) throw new Error(`atomic catalog backfill: ${error.message}`);
}

/**
 * Read the ceramic catalogue from the DB and reconstruct `Product[]` in
 * category → display-num order. Called in production (CATALOG_SOURCE=db) by
 * loadCeramicProductsFromDb via the ceramic accessors.
 */
export async function readCeramicProducts(supabase: SupabaseClient): Promise<Product[]> {
  const productsRes = await supabase
    .from('products')
    .select('*')
    .eq('type', 'ceramic')
    .abortSignal(supabaseTimeout());
  if (productsRes.error) throw new Error(`read products: ${productsRes.error.message}`);

  // Customer-facing reader: SKIP an invalid ceramic row (never render/sell at
  // 0 zł) — this is the actual M-4 fix. See read-schemas.ts's parseProductRow
  // doc comment for why this differs from the admin-only readers below.
  const rows = sortCeramicProductRows(parseProductRows(productsRes.data ?? []));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const mediaRes = await supabase
    .from('product_media')
    .select('*')
    .in('product_id', ids)
    .abortSignal(supabaseTimeout());
  if (mediaRes.error) throw new Error(`read media: ${mediaRes.error.message}`);

  return mapCeramicProducts(rows, (mediaRes.data ?? []) as MediaSeedRow[]);
}

/**
 * Read the print catalogue from the DB and reconstruct `PrintDesign[]` (all
 * designs, published and draft — `getPrintById` needs the drafts too). Called in
 * production (CATALOG_SOURCE=db) by loadPrintDesignsFromDb via the print
 * accessors. Variants and media are read in `position` order so the axis/gallery
 * reconstruction is stable.
 */
export async function readPrintDesigns(supabase: SupabaseClient): Promise<PrintDesign[]> {
  const productsRes = await supabase
    .from('products')
    .select('*')
    .eq('type', 'print')
    .order('num', { ascending: true })
    .abortSignal(supabaseTimeout());
  if (productsRes.error) throw new Error(`read prints: ${productsRes.error.message}`);

  const rawProducts = productsRes.data ?? [];
  const ids = rawProducts.map((r) => r.id);
  if (ids.length === 0) return [];

  const [variantsRes, mediaRes] = await Promise.all([
    supabase
      .from('product_variants')
      .select('*')
      .in('product_id', ids)
      .order('position', { ascending: true })
      .abortSignal(supabaseTimeout()),
    supabase
      .from('product_media')
      .select('*')
      .in('product_id', ids)
      .order('position', { ascending: true })
      .abortSignal(supabaseTimeout()),
  ]);
  if (variantsRes.error) throw new Error(`read print variants: ${variantsRes.error.message}`);
  if (mediaRes.error) throw new Error(`read print media: ${mediaRes.error.message}`);

  // Customer-facing reader: run through the same shared guard as
  // readCeramicProducts. In practice a `type='print'` query never returns a
  // ceramic row to skip, but applying the guard here anyway keeps the "no
  // reader can bypass validation" property uniform across all readers.
  return mapPrintDesigns(
    parseProductRows(rawProducts),
    (variantsRes.data ?? []) as VariantSeedRow[],
    (mediaRes.data ?? []) as MediaSeedRow[],
  );
}

/* ============================================================
   Write path (Stage 4a) — admin product metadata + publish status.
   Metadata remains a discrete single-row update. Status transitions use the
   atomic update_product_status_guarded RPC so the print readiness gate, write,
   and audit cannot drift. Metadata audit remains a separate best-effort write.
   `updated_at` is set explicitly (there is no moddatetime trigger).
   ============================================================ */

/** A single product row plus its variants + media, for the admin editor. */
export interface ProductEditorRow {
  product: ProductSeedRow;
  variants: VariantSeedRow[];
  media: MediaSeedRow[];
}

/** Read one product (with variants + media) for the editor. Null when absent. */
export async function readProductRow(
  supabase: SupabaseClient,
  id: string,
): Promise<ProductEditorRow | null> {
  const productRes = await supabase.from('products').select('*').eq('id', id).maybeSingle();
  if (productRes.error) throw new Error(`read product: ${productRes.error.message}`);
  if (!productRes.data) return null;

  const [variantsRes, mediaRes] = await Promise.all([
    supabase.from('product_variants').select('*').eq('product_id', id).order('position', { ascending: true }),
    supabase.from('product_media').select('*').eq('product_id', id).order('position', { ascending: true }),
  ]);
  if (variantsRes.error) throw new Error(`read variants: ${variantsRes.error.message}`);
  if (mediaRes.error) throw new Error(`read media: ${mediaRes.error.message}`);

  // Admin-only reader: validate + report (Sentry) but do NOT withhold the row.
  // getProductEditorState() (catalog-list.ts) already falls back to a stale
  // registry seed when this returns null — the one screen whose purpose is
  // inspecting/fixing exactly this kind of bad row must not go blind to it.
  parseProductRow(productRes.data);
  return {
    product: productRes.data as ProductSeedRow,
    variants: (variantsRes.data ?? []) as VariantSeedRow[],
    media: (mediaRes.data ?? []) as MediaSeedRow[],
  };
}

/** Insert an audit row; failures are logged, not fatal (the write already committed). */
async function writeCatalogAudit(
  supabase: SupabaseClient,
  entry: { product_id: string; actor_email: string | null; action: string; before: unknown; after: unknown },
): Promise<void> {
  const res = await supabase.from('catalog_audit_log').insert(entry);
  if (res.error) console.error('[catalog] audit write failed', entry.product_id, res.error.message);
}

/** Postgres unique-violation code (e.g. a slug collision on products.slug). */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Patch a product's editable metadata. Throws `product_not_found` (unknown id)
 * or `slug_taken` (unique violation on `slug`); the caller maps these to
 * 404 / 409 via `productError`.
 */
export async function updateProductMeta(
  supabase: SupabaseClient,
  id: string,
  patch: ProductUpdateInput,
  actorEmail: string | null,
): Promise<ProductSeedRow> {
  const before = await supabase.from('products').select('*').eq('id', id).maybeSingle();
  if (before.error) throw new Error(`load product: ${before.error.message}`);
  if (!before.data) throw new Error('product_not_found');

  const res = await supabase
    .from('products')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (res.error) {
    if (res.error.code === PG_UNIQUE_VIOLATION) throw new Error('slug_taken');
    throw new Error(`update product: ${res.error.message}`);
  }
  if (!res.data) throw new Error('product_not_found');

  await writeCatalogAudit(supabase, {
    product_id: id,
    actor_email: actorEmail,
    action: 'update',
    before: before.data,
    after: res.data,
  });
  // Admin-only write result: validate + report (Sentry) but do NOT withhold —
  // same posture as readProductRow/listCatalogRows (see parseProductRow's doc
  // comment). The admin editor patched this row and needs to see exactly what
  // was written, bad price included, not a silently swapped-in fallback.
  parseProductRow(res.data);
  return res.data as ProductSeedRow;
}

export class PrintAssetsIncompleteError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super('print_assets_incomplete');
    this.name = 'PrintAssetsIncompleteError';
    this.missing = missing;
  }
}

/**
 * Transition a product's publish status. Archiving is a soft-archive (status
 * only — the row and its order history are never deleted). The first activation
 * stamps `published_at`. Print products cannot move to `active` unless every
 * active variant has a ready fulfilment asset. The guarded RPC locks the
 * product and its coverage rows, revalidates readiness, updates status, and
 * writes the audit entry in one transaction. Throws `product_not_found` or
 * `PrintAssetsIncompleteError`.
 */
export async function updateProductStatus(
  supabase: SupabaseClient,
  id: string,
  status: ProductStatus,
  actorEmail: string | null,
): Promise<ProductSeedRow> {
  const { data, error } = await supabase.rpc('update_product_status_guarded', {
    p_product_id: id,
    p_status: status,
    p_actor_email: actorEmail,
  });
  if (error) {
    if (error.message.includes('product_not_found')) throw new Error('product_not_found');
    throw new Error(`update status: ${error.message}`);
  }

  const result = data as
    | { ok: true; product: ProductSeedRow }
    | { ok: false; error: string; missing?: unknown }
    | null;
  if (!result) throw new Error('update status: empty RPC response');
  if (!result.ok) {
    if (result.error === 'print_assets_incomplete') {
      const missing = Array.isArray(result.missing)
        ? result.missing.filter((key): key is string => typeof key === 'string')
        : [];
      throw new PrintAssetsIncompleteError(missing);
    }
    throw new Error(`update status: ${result.error}`);
  }
  // Admin-only write result: validate + report (Sentry) but do NOT withhold —
  // same posture as updateProductMeta/readProductRow (see parseProductRow's
  // doc comment).
  parseProductRow(result.product);
  return result.product;
}
