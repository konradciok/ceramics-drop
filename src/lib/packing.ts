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
   - Ceramics are never laid on their side: units only rotate around
     the vertical axis, so a vase taller than a gabaryt's slot height
     bumps the whole parcel up a size.
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
 * Greedy shelf layout on the 38 × 64 base: units sorted by footprint area,
 * placed left-to-right into rows along the 64 cm side (rotation in the
 * horizontal plane allowed), rows stacked along the 38 cm side.
 */
function shelfFits(units: Unit[]): boolean {
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
      if (rowX + x <= 64 && usedDepth + Math.max(rowDepth, y) <= 38) {
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
        if (x <= 64 && usedDepth + y <= 38) {
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

/**
 * Whether the units fit a slot of height `h` when arranged in horizontal
 * layers (tallest units first; each layer must pass the shelf check; layer
 * heights sum within the slot).
 */
function layeredFits(units: Unit[], slotH: number): boolean {
  if (units.some((u) => u.h > slotH)) return false;
  const sorted = [...units].sort((a, b) => b.h - a.h);
  const layers: Unit[][] = [];
  let current: Unit[] = [];
  for (const u of sorted) {
    if (shelfFits([...current, u])) {
      current.push(u);
    } else {
      if (current.length) layers.push(current);
      current = [u];
      if (!shelfFits(current)) return false; // single unit exceeds the base
    }
  }
  if (current.length) layers.push(current);
  const totalH = layers.reduce((s, layer) => s + Math.max(...layer.map((u) => u.h)), 0);
  return totalH <= slotH;
}

/** Full fit test for one parcel candidate at a given gabaryt. */
function fitsSize(units: Unit[], size: ParcelSize): boolean {
  const slot = PARCEL_DIMS[size];
  const volume = units.reduce((s, u) => s + unitVolume(u), 0);
  if (volume > MAX_FILL * slot.h * slot.w * slot.l) return false;
  if (sumWeight(units) + BOX_TARE_KG[size] > MAX_PARCEL_WEIGHT_KG) return false;
  return layeredFits(units, slot.h);
}

const SIZE_ORDER: ParcelSize[] = ['A', 'B', 'C'];

function smallestSize(units: Unit[]): ParcelSize | null {
  for (const size of SIZE_ORDER) {
    if (fitsSize(units, size)) return size;
  }
  return null;
}

/** Build packing units: wrap singles, stack flat plates per category. */
function buildUnits(ids: string[], notes: string[], warnings: string[]): Unit[] {
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
    const suffix = printDesigns.length === 1 ? 'druk' : 'druki';
    notes.push(`${printDesigns.length} ${suffix} (${[...new Set(printDesigns)].join(', ')}) — realizacja Prodigi, poza wysyłką InPost.`);
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

/**
 * Recommend an InPost package plan for a set of order line product ids.
 * Deterministic; safe against unknown/retired ids and print tokens.
 */
export function recommendPacking(productIds: string[]): PackingPlan {
  const notes: string[] = [];
  const warnings: string[] = [];
  const units = buildUnits(productIds, notes, warnings);

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
    packages.push({
      size,
      itemIds: group.flatMap((u) => u.ids).sort(),
      weightKg: Math.round((sumWeight(group) + BOX_TARE_KG[size]) * 100) / 100,
    });
  }
  // Deterministic order: biggest parcel first.
  packages.sort((a, b) => SIZE_ORDER.indexOf(b.size) - SIZE_ORDER.indexOf(a.size));

  if (packable.some((u) => u.ids.some((id) => getProductById(id)?.category.startsWith('wazony')))) {
    notes.push('Wazony pakować pionowo — nie kłaść na boku.');
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
