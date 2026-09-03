/* ============================================================
   Product catalogue — registry + accessors
   ------------------------------------------------------------
   The CATEGORIES registry below is the structural site map of the
   nine product families (slug, price, measure, count). It drives
   routing, navigation and the collection pages.

   getProducts() returns the full Product[] built in two passes:
     1. buildBase() generates the original pieces with STABLE ids
        (id never changes for a physical piece — it is the key used
        by piece_state / orders in the DB).
     2. applyInventoryReview() applies the artist's June inventory
        review as a declarative diff (removals, recategorisations,
        gallery merges), then renumbers the DISPLAY number (num) and
        noteIndex per category. Stable ids survive; only num/category
        change. This protects sold/ordered pieces from renumbering.
   ============================================================ */
import * as Sentry from '@sentry/nextjs';
import type { Category, CategorySlug, Product } from './types';
import { PRICE_PLN } from './pricing';
import { catalogSource } from './catalog/source';
import { recordCeramicCatalogSuccess, resolveCeramicCatalogFallback } from './catalog/last-known-good';

export const CATEGORIES: Record<CategorySlug, Category> = {
  kubki: { slug: 'kubki', nameKey: 'nav.kubki', singularKey: 'mug', price: PRICE_PLN['kubki'], measure: '8 × 8 × 10 cm', count: 29 },
  wazony: { slug: 'wazony', nameKey: 'nav.wazony', singularKey: 'vase', price: PRICE_PLN['wazony'], measure: '19,5 × 15 × 15 cm', count: 9 },
  'wazony-srednie': { slug: 'wazony-srednie', nameKey: 'nav.wazonySrednie', singularKey: 'midvase', price: PRICE_PLN['wazony-srednie'], measure: '25 × 16 × 16 cm', count: 5 },
  'wazony-duze': { slug: 'wazony-duze', nameKey: 'nav.wazonyDuze', singularKey: 'bigvase', price: PRICE_PLN['wazony-duze'], measure: '28 × 19 × 19 cm', count: 4 },
  talerzyki: { slug: 'talerzyki', nameKey: 'nav.talerzyki', singularKey: 'dish', price: PRICE_PLN['talerzyki'], measure: '12 × 12 × 3 cm', count: 14 },
  'talerze-srednie': { slug: 'talerze-srednie', nameKey: 'nav.talerzeSrednie', singularKey: 'medplate', price: PRICE_PLN['talerze-srednie'], measure: '⌀ 18 cm', count: 39 },
  'talerze-duze': { slug: 'talerze-duze', nameKey: 'nav.talerzeDuze', singularKey: 'plate', price: PRICE_PLN['talerze-duze'], measure: '⌀ 24 cm', count: 9 },
  'duze-michy': { slug: 'duze-michy', nameKey: 'nav.duzeMichy', singularKey: 'largebowl', price: PRICE_PLN['duze-michy'], measure: '24 × 24 × 11 cm', count: 6 },
  'miski-falowane': { slug: 'miski-falowane', nameKey: 'nav.miskiFalowane', singularKey: 'wavybowl', price: PRICE_PLN['miski-falowane'], measure: '18 × 18 × 9 cm', count: 10 },
  // ponytail: fine-art-prints not in CATEGORY_ORDER so never rendered via ceramic paths
  'fine-art-prints': { slug: 'fine-art-prints', nameKey: 'nav.fineArtPrints', singularKey: 'print', price: 0, measure: '', count: 0 },
};

/** Ordered list of category slugs (nav / footer / shop switcher order). */
export const CATEGORY_ORDER: CategorySlug[] = [
  'kubki',
  'wazony',
  'wazony-srednie',
  'wazony-duze',
  'talerzyki',
  'talerze-srednie',
  'talerze-duze',
  'duze-michy',
  'miski-falowane',
];

export function getCategory(slug: CategorySlug): Category {
  return CATEGORIES[slug];
}

/* ------------------------------------------------------------------
   Hidden categories — withdrawn from the public storefront.
   ------------------------------------------------------------------
   These families stay in the registry (stable ids, historical orders,
   invoices, webhooks and analytics keep working) but are removed from
   every public browsing surface: nav/footer, homepage, /sklep, the
   collection + product pages (HTTP 404), sitemap and the merchant feeds.
   The checkout API also hard-blocks them server-side (validateCart →
   `not_for_sale`) so a stale cart or private-sale link can never buy one.
   Un-hiding a family is a one-line change here. */
export const HIDDEN_CATEGORIES = new Set<CategorySlug>([]);

/** Whether a category is withdrawn from the public storefront. */
export function isCategoryHidden(slug: CategorySlug): boolean {
  return HIDDEN_CATEGORIES.has(slug);
}

/**
 * Whether a product is publicly visible (collection grids, /sklep, PDP, sitemap,
 * feeds). A non-`active` DB status (`draft`/`hidden`/`archived`) withdraws the
 * product; a hidden family withdraws its whole set. `sold`/`showroom` are NOT
 * checked here — those pieces still render (with a badge), they are just not
 * purchasable. In `CATALOG_SOURCE=code` mode `status` is undefined ⇒ `active`,
 * so this collapses to the pre-Stage-4 category-only visibility.
 */
export function isProductPublic(product: Product): boolean {
  return (product.status ?? 'active') === 'active' && !isCategoryHidden(product.category);
}

/** Whether a piece may be bought — publicly visible AND not sold / not in the showroom. */
export function isProductPurchasable(product: Product): boolean {
  return !product.sold && !product.showroom && isProductPublic(product);
}

/** CATEGORY_ORDER minus hidden families — nav / footer / switcher / jump-nav. */
export const VISIBLE_CATEGORY_ORDER: CategorySlug[] = CATEGORY_ORDER.filter(
  (slug) => !isCategoryHidden(slug),
);


const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);

type Spec = {
  slug: CategorySlug;
  prefix: string;
  imageBase: string;
  /** Image file numbers, in original order (skips reflect missing files). */
  files: number[];
};

/* Original generation specs. These define the STABLE id of every physical
   piece: id = prefix + pad(positionInFiles). Image stem is imageBase-file.
   Never reorder/edit these to "fix" the catalogue — that would renumber
   stable ids. Catalogue changes go through INVENTORY_REVIEW below. */
const SPECS: Spec[] = [
  { slug: 'kubki', prefix: 'k', imageBase: 'kubek', files: [...range(1, 26), 31] },
  { slug: 'wazony', prefix: 'v', imageBase: 'waza-mala', files: range(1, 9) },
  { slug: 'wazony-duze', prefix: 'd', imageBase: 'waza-duza', files: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { slug: 'talerzyki', prefix: 't', imageBase: 'talerz-maly', files: range(1, 31) },
  { slug: 'talerze-srednie', prefix: 's', imageBase: 'sredni-talerz', files: range(17, 39) },
  { slug: 'talerze-duze', prefix: 'p', imageBase: 'talerz-duzy', files: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13] },
  { slug: 'duze-michy', prefix: 'b', imageBase: 'duza-micha', files: range(1, 7) },
  { slug: 'miski-falowane', prefix: 'w', imageBase: 'miski-falowane', files: range(1, 17) },
  { slug: 'kubki', prefix: 'c', imageBase: 'kubek-kolejny-nr', files: [1, 2, 3, 4] },
  { slug: 'kubki', prefix: 'x', imageBase: 'kubek', files: [1] },  // smoke-test piece — remove after prod payment verified
  { slug: 'wazony-srednie', prefix: 'u', imageBase: 'sredni-wazon', files: [234] },
  { slug: 'wazony-duze', prefix: 'g', imageBase: 'duza-waza', files: [122] },
  { slug: 'duze-michy', prefix: 'h', imageBase: 'duza-miska', files: [23] },
];

/** Base piece: stable id + image, before the inventory review diff. */
type BasePiece = { id: string; category: CategorySlug; image: string };

function buildBase(): BasePiece[] {
  const base: BasePiece[] = [];
  for (const spec of SPECS) {
    spec.files.forEach((file, i) => {
      base.push({
        id: `${spec.prefix}${pad(i + 1)}`,
        category: spec.slug,
        image: `/uploads/${spec.imageBase}-${file}.webp`,
      });
    });
  }
  return base;
}

/* ------------------------------------------------------------------
   Inventory review — June drop (notatki ze spotkania z artystką).
   Expressed as a diff over the stable base so that ids never shift.
   ------------------------------------------------------------------ */

/** Pieces removed from sale entirely (drop from catalogue + piece_state). */
const REMOVED = new Set<string>([
  'k15', 'k16',                          // kubki
  'x01',                                 // smoke-test mug (prod payment verified)
  'v08', 'd04', 'd08',                   // wazy: out / duplicate
  't03',                                 // talerzyki
  'p04', 'p06', 'p11',                   // talerze-duze
  'b05', 'b06',                          // duże misy (galeria później)
  'w01', 'w02', 'w04', 'w10',            // miski falowane: out
  'w11', 'w13', 'w16',                   // miski falowane: scalone jako 2. zdjęcie
]);

/** Pieces moved to a different family (keep stable id, change category). */
const RECATEGORISE: Record<string, CategorySlug> = {
  // dawne "Duże wazony" rozbite na średnie + duże
  d01: 'wazony-srednie', d02: 'wazony-srednie', d03: 'wazony-srednie', d05: 'wazony-srednie',
  // swap między poziomami
  d10: 'wazony',         // duże Nº10 → małe
  // nowe talerzyki średnie — t16–t31 przeniesione do nowej kategorii
  t16: 'talerze-srednie', t17: 'talerze-srednie', t18: 'talerze-srednie', t19: 'talerze-srednie',
  t20: 'talerze-srednie', t21: 'talerze-srednie', t22: 'talerze-srednie', t23: 'talerze-srednie',
  t24: 'talerze-srednie', t25: 'talerze-srednie', t26: 'talerze-srednie', t27: 'talerze-srednie',
  t28: 'talerze-srednie', t29: 'talerze-srednie', t30: 'talerze-srednie', t31: 'talerze-srednie',
};

/** Display order overrides: pieces appended to the END of a family, in order. */
const APPEND_ORDER: Partial<Record<CategorySlug, string[]>> = {
  wazony: ['d10'],
};

/** Gallery merges: target id gets these extra image stems (second photos). */
const GALLERY_MERGE: Record<string, string[]> = {
  w12: ['/uploads/miski-falowane-11.webp'],
  w14: ['/uploads/miski-falowane-13.webp'],
  w15: ['/uploads/miski-falowane-16.webp'],
};

/** Per-product price overrides in PLN (used for test/one-off pieces). */
const PRICE_OVERRIDE: Record<string, number> = {};

/** Per-product measure overrides. */
const MEASURE_OVERRIDE: Record<string, string> = {};

/* ------------------------------------------------------------------
   Drop membership — which limited sales event a piece was released in.
   ------------------------------------------------------------------
   A static, code-owned fact (like `category`), not a DB column: drop
   membership records when a piece was authored into the catalogue and never
   needs runtime reassignment. Every current product belongs to Drop #1; a
   future drop adds an entry per new id here and a `drops` row via
   `npm run drop:create`. The `drops` table is the source of truth for a
   drop's status (active/ended) and display label. */
const DEFAULT_DROP_ID = 'drop-1';
const DROP_OVERRIDE: Record<string, string> = {
  // e.g. 'k28': 'drop-2' when the next drop ships.
};

function buildProducts(): Product[] {
  const base = buildBase().filter((p) => !REMOVED.has(p.id));

  // Apply recategorisation.
  for (const p of base) {
    const next = RECATEGORISE[p.id];
    if (next) p.category = next;
  }

  // Group per family, preserving base order, then appended movers.
  const byCat = CATEGORY_ORDER.reduce(
    (acc, slug) => {
      acc[slug] = [];
      return acc;
    },
    {} as Record<CategorySlug, BasePiece[]>,
  );
  for (const p of base) {
    if (!APPEND_ORDER[p.category]?.includes(p.id)) byCat[p.category].push(p);
  }
  for (const slug of CATEGORY_ORDER) {
    for (const id of APPEND_ORDER[slug] ?? []) {
      const piece = base.find((p) => p.id === id);
      if (piece) byCat[slug].push(piece);
    }
  }

  // Materialise: assign sequential display num + noteIndex, attach gallery.
  const products: Product[] = [];
  for (const slug of CATEGORY_ORDER) {
    const cat = CATEGORIES[slug];
    byCat[slug].forEach((p, i) => {
      products.push({
        id: p.id,
        category: slug,
        num: pad(i + 1),
        image: p.image,
        ...(GALLERY_MERGE[p.id] ? { gallery: GALLERY_MERGE[p.id] } : {}),
        price: PRICE_OVERRIDE[p.id] ?? cat.price,
        measure: MEASURE_OVERRIDE[p.id] ?? cat.measure,
        sold: false,
        dropId: DROP_OVERRIDE[p.id] ?? DEFAULT_DROP_ID,
        noteIndex: i,
      });
    });
  }
  return products;
}

/* The registry is static build-time data, so compute it once at module
   load and reuse it; lookups read from the prebuilt id map / groupings. */
const PRODUCTS = buildProducts();
const PRODUCT_BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));
const PRODUCTS_BY_CATEGORY = CATEGORY_ORDER.reduce(
  (acc, slug) => {
    acc[slug] = PRODUCTS.filter((p) => p.category === slug);
    return acc;
  },
  {} as Record<CategorySlug, Product[]>,
);

/* ------------------------------------------------------------------
   Sync registry helpers — read ONLY the code registry, never the DB.
   ------------------------------------------------------------------
   The public accessors below became async in Stage 3b so they can read the
   catalog shadow tables when CATALOG_SOURCE=db. These helpers keep the code
   registry available synchronously for the surfaces that cannot (or should not)
   go async in this stage: client components (which physically can't call the
   service-role Supabase client) and code-derived admin/fulfilment labels. At
   parity (registry == DB) they return exactly what the async accessors do in
   'code' mode; a later stage (4/7) migrates these onto the async catalog once
   DB-only products exist. */
export function registryProducts(): Product[] {
  return PRODUCTS;
}

export function registryProductById(id: string): Product | undefined {
  return PRODUCT_BY_ID.get(id);
}

export function registryProductsByCategory(slug: CategorySlug): Product[] {
  return PRODUCTS_BY_CATEGORY[slug];
}

/** Registry-only resolve (no DB) — used by client/code-derived cart surfaces. */
export function registryResolveKnownProducts(ids: string[]): Product[] {
  return ids
    .map((id) => PRODUCT_BY_ID.get(id))
    .filter((p): p is Product => p !== undefined);
}

/** Registry-only cart resolve (no DB) — mirrors resolveCartProducts on the client. */
export function registryResolveCartProducts(ids: string[]): Product[] {
  return registryResolveKnownProducts(ids).filter(isProductPurchasable);
}

/* ------------------------------------------------------------------
   Async catalog core — the single source the public accessors delegate to.
   ------------------------------------------------------------------
   'code' → the prebuilt registry structures (wrapped in a resolved promise,
   effectively zero-cost). 'db' → the direct DB read (loadCeramicProductsFromDb),
   from which the same id/category groupings are rebuilt with the
   same logic. The db branch is a DYNAMIC import so the Cloudflare-only DB code
   never loads in node/tests under the default 'code' flag, and to avoid a
   static import cycle (load → repository → seed → products). */
export type CeramicCatalog = {
  products: Product[];
  byId: Map<string, Product>;
  byCategory: Record<CategorySlug, Product[]>;
};

function groupByCategory(products: Product[]): Record<CategorySlug, Product[]> {
  return CATEGORY_ORDER.reduce(
    (acc, slug) => {
      acc[slug] = products.filter((p) => p.category === slug);
      return acc;
    },
    {} as Record<CategorySlug, Product[]>,
  );
}

const REGISTRY_CATALOG: CeramicCatalog = {
  products: PRODUCTS,
  byId: PRODUCT_BY_ID,
  byCategory: PRODUCTS_BY_CATEGORY,
};

async function loadCeramicCatalog(): Promise<CeramicCatalog> {
  if (catalogSource() === 'code') return REGISTRY_CATALOG;
  // Resilience default: a DB read failure (including a bounded Supabase
  // timeout — see supabase-timeout.ts) degrades first to this isolate's
  // last-known-good catalog (real DB data, so status/draft/hidden/archived
  // carries through exactly) rather than the bare code registry, which has
  // no non-active status to fall back on and would silently re-publish a
  // withdrawn product (SEO-003). Only a cold isolate that has never served a
  // successful DB read yet falls back further, to a fail-closed projection
  // (nothing public) — see src/lib/catalog/last-known-good.ts. The blip is
  // logged + reported to Sentry, tagged by which tier served; a real edit
  // reappears once the DB recovers. Reversible to fail-loud by rethrowing.
  //
  // Deliberately NOT using the generic readWithFallback() helper here: its
  // `fallback` argument is evaluated eagerly, before the DB read is even
  // attempted. A concurrent request on this isolate can record a fresher
  // last-known-good catalog while THIS read is still in flight — resolving
  // the fallback up front would ignore that and serve a stale (possibly
  // cold-fail-closed) tier even though a better one is available by the time
  // this read actually fails. Resolving inside the catch, after the read has
  // settled, always reflects the freshest state.
  try {
    const { loadCeramicProductsFromDb } = await import('./catalog/load');
    const products = await loadCeramicProductsFromDb();
    const catalog: CeramicCatalog = {
      products,
      byId: new Map(products.map((p) => [p.id, p])),
      byCategory: groupByCategory(products),
    };
    recordCeramicCatalogSuccess(catalog);
    return catalog;
  } catch (err) {
    const { catalog, tier } = resolveCeramicCatalogFallback(REGISTRY_CATALOG);
    console.error('[ceramic-catalog] DB read failed; using fallback', { fallbackTier: tier }, err);
    // fallbackTier as a tag (not `extra`) so the two tiers are filterable in
    // Sentry, distinct from a generic Supabase hiccup.
    Sentry.captureException(err, { tags: { supabaseTimeoutLabel: 'ceramic-catalog', fallbackTier: tier } });
    return catalog;
  }
}

/**
 * Returns every product across the nine categories, each with image
 * path, optional gallery, sold flag, price, measure, and display index.
 */
export async function getProducts(): Promise<Product[]> {
  return (await loadCeramicCatalog()).products;
}

/**
 * Products shown on public browsing surfaces (shop, sitemap, merchant feeds) —
 * the full catalogue minus the hidden families. Sold pieces are kept (the sold
 * overlay is applied at render time; feeds mark them out-of-stock).
 */
export async function getPublicProducts(): Promise<Product[]> {
  return (await loadCeramicCatalog()).products.filter(isProductPublic);
}

export async function getProductsByCategory(slug: CategorySlug): Promise<Product[]> {
  // Public grid + PDP siblings + collection JSON-LD read this — withdraw any
  // non-active product (db mode only; `code` has no status ⇒ all active).
  return ((await loadCeramicCatalog()).byCategory[slug] ?? []).filter(isProductPublic);
}

export async function getProductById(id: string): Promise<Product | undefined> {
  return (await loadCeramicCatalog()).byId.get(id);
}

/** Resolve known products by id without filtering sold pieces. */
export async function resolveKnownProducts(ids: string[]): Promise<Product[]> {
  const { byId } = await loadCeramicCatalog();
  return ids
    .map((id) => byId.get(id))
    .filter((p): p is Product => p !== undefined);
}

/**
 * Resolves a list of cart ids to the products that may actually be bought —
 * dropping unknown ids, sold (one-of-a-kind, already-gone) pieces, and pieces
 * in hidden (withdrawn) families. Used by the cart surfaces so stale
 * localStorage can never reintroduce sold or withdrawn inventory.
 */
export async function resolveCartProducts(ids: string[]): Promise<Product[]> {
  return (await resolveKnownProducts(ids)).filter(isProductPurchasable);
}
