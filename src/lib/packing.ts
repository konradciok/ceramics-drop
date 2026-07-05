/* ============================================================
   InPost package recommendation (cartonization estimate)
   ------------------------------------------------------------
   Pure, deterministic heuristic that maps an order's product ids
   to a recommended InPost Paczkomat package plan (gabaryt A/B/C,
   possibly split into several parcels). Used by the admin panel
   as packing guidance — it does NOT drive shipment creation
   (`shipx.ts` still sends its fixed default parcel).

   Model (ceramic-specific, deliberately conservative):
   - Every piece is handmade ceramic → very fragile. Each item gets
     +2 cm of wrap per dimension; flat plates are stacked (max 4 per
     stack, cardboard divider between plates) and the stack is
     treated as one packing unit.
   - Units only rotate around the vertical axis, with one studio-approved
     exception: small vases (`wazony`) may ship on their side when snugly
     immobilized, and only when that strictly lowers the plan's cost
     (fewer parcels or smaller gabaryty). Medium/large vases and all
     other pieces stay upright, so a piece taller than a gabaryt's slot
     height bumps the whole parcel up a size.
   - A parcel "fits" a gabaryt when every unit stands within the slot
     height, the units arrange onto the 38 × 64 cm base via a greedy
     shelf layout (taller layers first, layer heights sum within the
     slot), padded volume stays ≤ 75% of the slot, and weight incl.
     box tare stays ≤ 25 kg.
   - Orders that overflow gabaryt C split first-fit-decreasing by
     volume into multiple parcels, each assigned its smallest gabaryt.

   Weights are per-category estimates (no piece is weighed anywhere
   in the system), so the output is guidance, not a carrier contract.
   Fine-art prints ship via the Prodigi flow and are excluded here.
   ============================================================ */
import { getProductById } from './products';
import { getPrintById } from './prints';
import { isPrintToken } from './print-cart';
import type { CategorySlug } from './types';

export type ParcelSize = 'A' | 'B' | 'C';

/** InPost Paczkomat slots: height × width × length (external, cm). */
export const PARCEL_DIMS: Record<ParcelSize, { h: number; w: number; l: number }> = {
  A: { h: 8, w: 38, l: 64 },
  B: { h: 19, w: 38, l: 64 },
  C: { h: 41, w: 38, l: 64 },
};

export const PARCEL_LABEL: Record<ParcelSize, string> = {
  A: 'Gabaryt A (8 × 38 × 64 cm)',
  B: 'Gabaryt B (19 × 38 × 64 cm)',
  C: 'Gabaryt C (41 × 38 × 64 cm)',
};

/** Empty-box weight added per parcel (carton + fill), kg. */
const BOX_TARE_KG: Record<ParcelSize, number> = { A: 0.2, B: 0.35, C: 0.55 };

const MAX_PARCEL_WEIGHT_KG = 25;
/** Padded contents may fill at most this share of the slot volume. */
const MAX_FILL = 0.75;
/** Above this fill share the estimate is tight → confidence drops. */
const TIGHT_FILL = 0.6;

/** Bubble-wrap allowance added to every dimension of every unit, cm. */
const WRAP_CM = 2;
/** Cardboard divider between stacked plates, cm. */
const PLATE_DIVIDER_CM = 0.7;
/** Plates per stack cap — taller ceramic piles are unsafe to handle. */
const MAX_PLATES_PER_STACK = 4;

/** Footprint (base) + standing height of the raw piece, cm, and estimated weight. */
type PackSpec = { base: [number, number]; h: number; weightKg: number; stackable?: boolean };

/** Every family except prints ships in a box — a new ceramic category must add its spec here. */
type ShippableCategorySlug = Exclude<CategorySlug, 'fine-art-prints'>;

/* Raw dims come from the category `measure` strings in products.ts
   (vases list height first, everything else lists it last). Weights are
   stoneware estimates — nothing in the codebase or DB stores real ones.
   Exported so tests can assert the dims stay in sync with the registry. */
export const PACK_SPECS = {
  kubki: { base: [8, 8], h: 10, weightKg: 0.35 },
  wazony: { base: [15, 15], h: 19.5, weightKg: 0.9 },
  'wazony-srednie': { base: [16, 16], h: 25, weightKg: 1.3 },
  'wazony-duze': { base: [19, 19], h: 28, weightKg: 1.7 },
  talerzyki: { base: [12, 12], h: 3, weightKg: 0.25, stackable: true },
  'talerze-srednie': { base: [18, 18], h: 3, weightKg: 0.45, stackable: true },
  'talerze-duze': { base: [24, 24], h: 3, weightKg: 0.7, stackable: true },
  'duze-michy': { base: [24, 24], h: 11, weightKg: 1.2 },
  'miski-falowane': { base: [18, 18], h: 9, weightKg: 0.6 },
} satisfies Record<ShippableCategorySlug, PackSpec>;

export type PackedParcel = {
  size: ParcelSize;
  /** Product ids packed into this parcel. */
  itemIds: string[];
  /** Contents + box tare, kg. */
  weightKg: number;
  /** Stocked custom carton code (see CUSTOM_CARTONS), or null → stock/full-slot box. */
  carton: CartonCode | null;
};

export type PackingConfidence = 'high' | 'medium' | 'low';

export type PackingPlan = {
  packages: PackedParcel[];
  /** Compact plan, e.g. `B`, `C + A`, `2×C`, `—` (nothing to ship). */
  planLabel: string;
  totalWeightKg: number;
  confidence: PackingConfidence;
  manualReview: boolean;
  /** Polish handling hints (packing orientation, out-of-scope items). */
  notes: string[];
  /** Polish problems that need operator attention (drive `manualReview`). */
  warnings: string[];
};

/** One physical thing to place in a box: a wrapped piece or a plate stack. */
type Unit = { ids: string[]; fp: [number, number]; h: number; weightKg: number };

const unitVolume = (u: Unit) => u.fp[0] * u.fp[1] * u.h;
const sumWeight = (units: Unit[]) => units.reduce((s, u) => s + u.weightKg, 0);

/**
 * Greedy shelf layout on an L × W base: units sorted by footprint area,
 * placed left-to-right into rows along the L side (rotation in the
 * horizontal plane allowed), rows stacked along the W side.
 */
function shelfFits(units: Unit[], baseL: number, baseW: number): boolean {
  const sorted = [...units].sort((a, b) => b.fp[0] * b.fp[1] - a.fp[0] * a.fp[1]);
  let usedDepth = 0;
  let rowDepth = 0;
  let rowX = 0;
  for (const u of sorted) {
    const orientations: [number, number][] =
      u.fp[0] === u.fp[1] ? [[u.fp[0], u.fp[1]]] : [[u.fp[0], u.fp[1]], [u.fp[1], u.fp[0]]];
    // Prefer the orientation that keeps the row shallow.
    orientations.sort((a, b) => a[1] - b[1]);
    let placed = false;
    for (const [x, y] of orientations) {
      if (rowX + x <= baseL && usedDepth + Math.max(rowDepth, y) <= baseW) {
        rowX += x;
        rowDepth = Math.max(rowDepth, y);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Close the row, start a new one with this unit.
      usedDepth += rowDepth;
      rowX = 0;
      rowDepth = 0;
      for (const [x, y] of orientations) {
        if (x <= baseL && usedDepth + y <= baseW) {
          rowX = x;
          rowDepth = y;
          placed = true;
          break;
        }
      }
      if (!placed) return false;
    }
  }
  return true;
}

/** Shelf check in either orientation of a (possibly non-square) base. */
function baseFits(units: Unit[], box: { w: number; l: number }): boolean {
  return shelfFits(units, box.l, box.w) || (box.l !== box.w && shelfFits(units, box.w, box.l));
}

/**
 * Whether the units fit a box of the given dims when arranged in horizontal
 * layers (tallest units first; each layer must pass the shelf check; layer
 * heights sum within the box height).
 */
function layeredFits(units: Unit[], box: { h: number; w: number; l: number }): boolean {
  if (units.some((u) => u.h > box.h)) return false;
  const sorted = [...units].sort((a, b) => b.h - a.h);
  const layers: Unit[][] = [];
  let current: Unit[] = [];
  for (const u of sorted) {
    if (baseFits([...current, u], box)) {
      current.push(u);
    } else {
      if (current.length) layers.push(current);
      current = [u];
      if (!baseFits(current, box)) return false; // single unit exceeds the base
    }
  }
  if (current.length) layers.push(current);
  const totalH = layers.reduce((s, layer) => s + Math.max(...layer.map((u) => u.h)), 0);
  return totalH <= box.h;
}

/** Full fit test for one parcel candidate at a given gabaryt. */
function fitsSize(units: Unit[], size: ParcelSize): boolean {
  const slot = PARCEL_DIMS[size];
  const volume = units.reduce((s, u) => s + unitVolume(u), 0);
  if (volume > MAX_FILL * slot.h * slot.w * slot.l) return false;
  if (sumWeight(units) + BOX_TARE_KG[size] > MAX_PARCEL_WEIGHT_KG) return false;
  return layeredFits(units, slot);
}

const SIZE_ORDER: ParcelSize[] = ['A', 'B', 'C'];

function smallestSize(units: Unit[]): ParcelSize | null {
  for (const size of SIZE_ORDER) {
    if (fitsSize(units, size)) return size;
  }
  return null;
}

/* ------------------------------------------------------------------
   Custom stock cartons — derived from the 2026-06/07 order history.
   Gabaryt-sized boxes run at 3–24% fill for real orders, so the studio
   stocks two snug reusable sizes instead; anything they can't hold
   ships in a made-to-measure / full-slot box.
   ------------------------------------------------------------------ */
export type CustomCarton = {
  code: string;
  /** External dims, cm (what the supplier quotes and the locker slot sees). */
  l: number;
  w: number;
  h: number;
  /** Smallest gabaryt slot the empty carton itself fits into. */
  slot: ParcelSize;
  /** Empty carton + fill weight, kg (lighter than a full-slot box). */
  tareKg: number;
  label: string;
};

/** Wall/fold allowance per dimension: internal space = external − 1 cm. */
const CARTON_WALL_CM = 1;

export const CUSTOM_CARTONS = [
  // Flatware laid side by side: single plates and mixed-size pairs. (A stacked
  // same-size pair is ~8.7 cm tall — over the 8 cm A slot itself, so those
  // orders are gabaryt B and belong to K2, never K1.)
  { code: 'K1', l: 36, w: 26, h: 7, slot: 'A', tareKg: 0.15, label: 'Karton K1 (36 × 26 × 7 cm)' },
  // Universal mix: mugs/plates/bowls and a lying small vase (1 cm clearance in slot B).
  { code: 'K2', l: 44, w: 32, h: 18, slot: 'B', tareKg: 0.3, label: 'Karton K2 (44 × 32 × 18 cm)' },
] as const satisfies readonly CustomCarton[];

export type CartonCode = (typeof CUSTOM_CARTONS)[number]['code'];

/**
 * The stocked carton this parcel's contents fit into, if any. The fit runs
 * against the carton's INTERNAL dims (external − wall allowance). Only
 * cartons that themselves fit the parcel's assigned gabaryt slot are
 * considered, so the carton never silently bumps the label up a size.
 */
function assignCarton(units: Unit[], parcelSize: ParcelSize): (typeof CUSTOM_CARTONS)[number] | null {
  for (const c of CUSTOM_CARTONS) {
    if (SIZE_ORDER.indexOf(c.slot) > SIZE_ORDER.indexOf(parcelSize)) continue;
    const inner = { l: c.l - CARTON_WALL_CM, w: c.w - CARTON_WALL_CM, h: c.h - CARTON_WALL_CM };
    const volume = units.reduce((s, u) => s + unitVolume(u), 0);
    if (volume > MAX_FILL * inner.l * inner.w * inner.h) continue;
    if (layeredFits(units, inner)) return c;
  }
  return null;
}

/**
 * Build packing units: wrap singles, stack flat plates per category.
 * With `laySmallVases`, small vases (`wazony`) are modelled on their side
 * (21.5 × 17 footprint, 17 cm tall) instead of upright — the studio-approved
 * policy for snugly immobilized small vases; bigger vases stay upright.
 */
function buildUnits(
  ids: string[],
  notes: string[],
  warnings: string[],
  laySmallVases = false,
): Unit[] {
  const units: Unit[] = [];
  const plates = new Map<CategorySlug, { ids: string[]; spec: PackSpec }>();
  const printDesigns: string[] = [];

  for (const id of ids) {
    // Prints appear as cart tokens (`print:fap01:…`) on cart surfaces and as
    // bare design ids (`fap01`) in persisted order_items — exclude both.
    if (isPrintToken(id)) {
      printDesigns.push(id.split(':')[1] ?? id);
      continue;
    }
    if (getPrintById(id)) {
      printDesigns.push(id);
      continue;
    }
    const product = getProductById(id);
    const spec: PackSpec | undefined =
      product && product.category !== 'fine-art-prints' ? PACK_SPECS[product.category] : undefined;
    if (!product || !spec) {
      warnings.push(`Nieznany produkt ${id} — pominięty w planie, sprawdź ręcznie.`);
      continue;
    }
    if (spec.stackable) {
      let group = plates.get(product.category);
      if (!group) {
        group = { ids: [], spec };
        plates.set(product.category, group);
      }
      group.ids.push(id);
    } else if (laySmallVases && product.category === 'wazony') {
      // On its side: raw height becomes the length, the base becomes the height.
      units.push({
        ids: [id],
        fp: [spec.h + WRAP_CM, spec.base[1] + WRAP_CM],
        h: spec.base[0] + WRAP_CM,
        weightKg: spec.weightKg,
      });
    } else {
      units.push({
        ids: [id],
        fp: [spec.base[0] + WRAP_CM, spec.base[1] + WRAP_CM],
        h: spec.h + WRAP_CM,
        weightKg: spec.weightKg,
      });
    }
  }

  for (const { ids: plateIds, spec } of plates.values()) {
    for (let i = 0; i < plateIds.length; i += MAX_PLATES_PER_STACK) {
      const stack = plateIds.slice(i, i + MAX_PLATES_PER_STACK);
      units.push({
        ids: stack,
        fp: [spec.base[0] + WRAP_CM, spec.base[1] + WRAP_CM],
        h: stack.length * spec.h + (stack.length - 1) * PLATE_DIVIDER_CM + WRAP_CM,
        weightKg: stack.length * spec.weightKg,
      });
    }
  }

  if (printDesigns.length > 0) {
    const n = printDesigns.length;
    const suffix =
      n === 1 ? 'druk' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'druki' : 'druków';
    notes.push(`${n} ${suffix} (${[...new Set(printDesigns)].join(', ')}) — realizacja Prodigi, poza wysyłką InPost.`);
  }

  return units;
}

/** First-fit-decreasing split across multiple gabaryt-C parcels. */
function splitParcels(units: Unit[]): Unit[][] {
  const sorted = [...units].sort((a, b) => unitVolume(b) - unitVolume(a));
  const parcels: Unit[][] = [];
  for (const u of sorted) {
    const target = parcels.find((p) => fitsSize([...p, u], 'C'));
    if (target) target.push(u);
    else parcels.push([u]);
  }
  return parcels;
}

function buildPlanLabel(sizes: ParcelSize[]): string {
  if (sizes.length === 0) return '—';
  const counts = new Map<ParcelSize, number>();
  for (const s of sizes) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...SIZE_ORDER]
    .reverse()
    .filter((s) => counts.has(s))
    .map((s) => (counts.get(s)! > 1 ? `${counts.get(s)}×${s}` : s))
    .join(' + ');
}

/** Units → sized parcels (with carton assignment). Shared by both vase passes. */
function assemblePlan(units: Unit[], warnings: string[]): { packages: PackedParcel[]; tightParcel: boolean } {
  // Units no single parcel can ever hold (nothing in the catalogue today).
  const packable: Unit[] = [];
  for (const u of units) {
    if (fitsSize([u], 'C')) {
      packable.push(u);
    } else {
      warnings.push(`${u.ids.join(', ')} — przekracza gabaryt C, wymaga wysyłki kurierem niestandardowym.`);
    }
  }

  const groups = packable.length === 0 ? [] : fitsSize(packable, 'C') ? [packable] : splitParcels(packable);

  let tightParcel = false;
  const packages: PackedParcel[] = [];
  for (const group of groups) {
    // Every group was assembled under the C fit test, so this only trips if
    // the split/fit contract is broken by a future change.
    const size = smallestSize(group);
    if (!size) {
      warnings.push(`${group.flatMap((u) => u.ids).join(', ')} — nie udało się dopasować gabarytu, sprawdź ręcznie.`);
      continue;
    }
    const slot = PARCEL_DIMS[size];
    const fill = group.reduce((s, u) => s + unitVolume(u), 0) / (slot.h * slot.w * slot.l);
    if (fill > TIGHT_FILL) tightParcel = true;
    const carton = assignCarton(group, size);
    packages.push({
      size,
      itemIds: group.flatMap((u) => u.ids).sort(),
      weightKg: Math.round((sumWeight(group) + (carton?.tareKg ?? BOX_TARE_KG[size])) * 100) / 100,
      carton: carton?.code ?? null,
    });
  }
  // Deterministic order: biggest parcel first.
  packages.sort((a, b) => SIZE_ORDER.indexOf(b.size) - SIZE_ORDER.indexOf(a.size));
  return { packages, tightParcel };
}

/** Lower is better: fewer parcels first, then smaller (cheaper) gabaryty. */
function planCost(packages: PackedParcel[]): [number, number] {
  return [packages.length, packages.reduce((s, p) => s + SIZE_ORDER.indexOf(p.size), 0)];
}

/**
 * Recommend an InPost package plan for a set of order line product ids.
 * Deterministic; safe against unknown/retired ids and print tokens.
 */
export function recommendPacking(productIds: string[]): PackingPlan {
  const notes: string[] = [];
  const warnings: string[] = [];
  const upright = buildUnits(productIds, notes, warnings);
  let { packages, tightParcel } = assemblePlan(upright, warnings);

  // Small vases may ship on their side (studio policy) — take the lying plan
  // only when it is strictly cheaper (fewer parcels or smaller gabaryty).
  const categories = new Set(
    productIds.map((id) => getProductById(id)?.category).filter((c): c is CategorySlug => !!c),
  );
  let vasesLaid = false;
  // A single gabaryt-A parcel is already the cheapest possible planCost ([1, 0] —
  // fewest parcels, smallest size) so no vase rearrangement could ever beat it;
  // skip the redundant second assemblePlan for the common already-optimal order.
  const uprightIsOptimal = packages.length === 1 && packages[0].size === 'A';
  if (categories.has('wazony') && !uprightIsOptimal) {
    const lying = assemblePlan(buildUnits(productIds, [], [], true), []);
    const packedCount = (ps: PackedParcel[]) => ps.reduce((s, p) => s + p.itemIds.length, 0);
    const [aN, aS] = planCost(packages);
    const [bN, bS] = planCost(lying.packages);
    // Same items packed, strictly cheaper → the lying plan wins.
    if (packedCount(lying.packages) === packedCount(packages) && (bN < aN || (bN === aN && bS < aS))) {
      ({ packages, tightParcel } = lying);
      vasesLaid = true;
    }
  }

  if (vasesLaid) {
    notes.push('Wazon kłaść poziomo, ciasno unieruchomiony — nie może się toczyć.');
  }
  const uprightVases = vasesLaid
    ? categories.has('wazony-srednie') || categories.has('wazony-duze')
    : [...categories].some((c) => c.startsWith('wazony'));
  if (uprightVases) {
    notes.push(`Wazony${vasesLaid ? ' (średnie/duże)' : ''} pakować pionowo — nie kłaść na boku.`);
  }

  const manualReview = warnings.length > 0;
  const confidence: PackingConfidence = manualReview ? 'low' : packages.length > 1 || tightParcel ? 'medium' : 'high';

  return {
    packages,
    planLabel: buildPlanLabel(packages.map((p) => p.size)),
    totalWeightKg: Math.round(packages.reduce((s, p) => s + p.weightKg, 0) * 100) / 100,
    confidence,
    manualReview,
    notes,
    warnings,
  };
}
