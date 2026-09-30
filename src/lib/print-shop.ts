/* ============================================================
   Print shop view logic (/sklep) — pure, dependency-free.
   ------------------------------------------------------------
   Every fine-art print shares the same sizes, format and price list, so the
   only axes that tell designs apart are collection, colour and recency. The
   server ranks designs once (buildShopRanks) and both the server (first
   paint from ?query) and the client island (interactive filtering) run the
   same applyShopView(), so a shared link renders identically either way.
   The repo has no DOM test harness — all decision logic lives here.
   ============================================================ */

export const SHOP_COLOURS = ['blue', 'green', 'warm', 'pink', 'earth', 'mono'] as const;
export type ShopColour = (typeof SHOP_COLOURS)[number];

export const SHOP_SORTS = ['featured', 'new', 'collection'] as const;
export type ShopSort = (typeof SHOP_SORTS)[number];

export interface ShopView {
  sort: ShopSort;
  /** Selected colour families; a design matches when it carries ANY of them. */
  colours: ShopColour[];
  /** Collection slug; undefined = every collection. */
  collection?: string;
}

export const DEFAULT_SHOP_VIEW: ShopView = { sort: 'featured', colours: [] };

/** Rank of a design under each sort — lower renders first. */
export interface ShopRanks {
  featured: number;
  new: number;
  collection: number;
}

export interface ShopFilterable {
  collectionSlug?: string;
  colours: readonly ShopColour[];
  rank: ShopRanks;
}

type ParamValue = string | string[] | undefined | null;
/** Next's `searchParams` record or the browser's `URLSearchParams`. */
export type ShopParamSource = { get(name: string): string | null } | Record<string, ParamValue>;

function readParam(source: ShopParamSource, name: string): string | undefined {
  if (typeof (source as { get?: unknown }).get === 'function') {
    return (source as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const raw = (source as Record<string, ParamValue>)[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first ?? undefined;
}

/**
 * Query → view. Total: unknown / malformed values fall back to the default
 * for that axis rather than throwing, so a stale or hand-edited link still
 * renders the shop. `knownCollections` (when given) drops unknown slugs.
 */
export function parseShopView(source: ShopParamSource, knownCollections?: readonly string[]): ShopView {
  const sortRaw = readParam(source, 'sort');
  const sort = (SHOP_SORTS as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as ShopSort) : DEFAULT_SHOP_VIEW.sort;

  const colours = [
    ...new Set(
      (readParam(source, 'kolor') ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter((c): c is ShopColour => (SHOP_COLOURS as readonly string[]).includes(c)),
    ),
  ];

  const collectionRaw = readParam(source, 'kolekcja')?.trim();
  const collection = collectionRaw && (!knownCollections || knownCollections.includes(collectionRaw)) ? collectionRaw : undefined;

  return { sort, colours, ...(collection && { collection }) };
}

/** View → query string (no leading '?'); defaults are omitted so the plain shop URL stays clean. */
export function serializeShopView(view: ShopView): string {
  const params = new URLSearchParams();
  if (view.sort !== DEFAULT_SHOP_VIEW.sort) params.set('sort', view.sort);
  if (view.colours.length > 0) params.set('kolor', SHOP_COLOURS.filter((c) => view.colours.includes(c)).join(','));
  if (view.collection) params.set('kolekcja', view.collection);
  // URLSearchParams encodes the comma; keep the URL readable.
  return params.toString().replace(/%2C/g, ',');
}

/** True when no narrowing is applied (sort alone does not count as a filter). */
export function hasActiveFilters(view: ShopView): boolean {
  return view.colours.length > 0 || !!view.collection;
}

/** Filter, then order by the chosen rank. Stable for equal ranks. */
export function applyShopView<T extends ShopFilterable>(items: readonly T[], view: ShopView): T[] {
  return items
    .filter((item) => {
      if (view.collection && item.collectionSlug !== view.collection) return false;
      if (view.colours.length > 0 && !item.colours.some((c) => view.colours.includes(c))) return false;
      return true;
    })
    .sort((a, b) => a.rank[view.sort] - b.rank[view.sort]);
}

/**
 * Round-robin across collections: first design of each collection, then the
 * second of each, and so on. The default "featured" order therefore opens on
 * variety instead of a long run from one series.
 */
export function interleaveByCollection<T>(groups: readonly { designs: readonly T[] }[]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...groups.map((g) => g.designs.length));
  for (let i = 0; i < longest; i++) {
    for (const g of groups) {
      if (i < g.designs.length) out.push(g.designs[i]);
    }
  }
  return out;
}

/** Numeric part of a `fapNNN` id — later batches have higher numbers. */
export function designSequence(id: string): number {
  const n = Number(id.replace(/\D/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** The `count` most recent designs (highest ids) — drives the "New" badge. */
export function newestIds(ids: readonly string[], count: number): Set<string> {
  return new Set([...ids].sort((a, b) => designSequence(b) - designSequence(a)).slice(0, Math.max(0, count)));
}

/**
 * Rank every design under all three sorts.
 *  - collection: curated collection order, then curated order inside each.
 *  - new: highest id first (ties keep collection order).
 *  - featured: pinned ids (in the configured order) first, then the rest
 *    interleaved across collections.
 * `groups` must already be the grouped, published designs (groupPrintDesigns).
 */
export function buildShopRanks(
  groups: readonly { designs: readonly { id: string }[] }[],
  featured: readonly string[] = [],
): Map<string, ShopRanks> {
  const inCollectionOrder = groups.flatMap((g) => g.designs.map((d) => d.id));
  const collectionRank = new Map(inCollectionOrder.map((id, i) => [id, i]));

  const newOrder = [...inCollectionOrder].sort(
    (a, b) => designSequence(b) - designSequence(a) || (collectionRank.get(a) ?? 0) - (collectionRank.get(b) ?? 0),
  );

  const present = new Set(inCollectionOrder);
  const pinned = [...new Set(featured)].filter((id) => present.has(id));
  const pinnedSet = new Set(pinned);
  const rest = interleaveByCollection(
    groups.map((g) => ({ designs: g.designs.map((d) => d.id).filter((id) => !pinnedSet.has(id)) })),
  );
  const featuredOrder = [...pinned, ...rest];

  const newRank = new Map(newOrder.map((id, i) => [id, i]));
  const featuredRank = new Map(featuredOrder.map((id, i) => [id, i]));
  return new Map(
    inCollectionOrder.map((id) => [
      id,
      { featured: featuredRank.get(id) ?? 0, new: newRank.get(id) ?? 0, collection: collectionRank.get(id) ?? 0 },
    ]),
  );
}
