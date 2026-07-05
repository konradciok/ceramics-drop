import { describe, expect, it } from 'vitest';
import { PACK_SPECS, PARCEL_DIMS, recommendPacking, type PackingPlan } from './packing';
import { CATEGORIES, CATEGORY_ORDER, getProductById } from './products';
import { encodePrintToken } from './print-cart';

/** Every input id lands in exactly one parcel (unknown/print ids excluded). */
function packedIds(plan: PackingPlan): string[] {
  return plan.packages.flatMap((p) => p.itemIds).sort();
}

function assertInvariants(plan: PackingPlan) {
  for (const parcel of plan.packages) {
    expect(parcel.itemIds.length).toBeGreaterThan(0);
    expect(parcel.weightKg).toBeLessThanOrEqual(25);
    expect(PARCEL_DIMS[parcel.size]).toBeDefined();
  }
  const all = packedIds(plan);
  expect(new Set(all).size).toBe(all.length);
}

describe('PACK_SPECS', () => {
  it('stays in sync with the category measures in the product registry', () => {
    for (const slug of CATEGORY_ORDER) {
      if (slug === 'fine-art-prints') continue; // prints ship via Prodigi, no pack spec
      const spec = PACK_SPECS[slug];
      expect(spec, `missing pack spec for ${slug}`).toBeDefined();
      const numbers = (CATEGORIES[slug].measure.match(/\d+(?:,\d+)?/g) ?? []).map((n) => Number(n.replace(',', '.')));
      if (CATEGORIES[slug].measure.includes('⌀')) {
        // Plates give only a diameter — the footprint must match it (height stays an estimate).
        expect(numbers).toHaveLength(1);
        expect(spec.base).toEqual([numbers[0], numbers[0]]);
      } else {
        // Full W × D × H measures: the spec's three dims must be the same multiset
        // (vases list height first, everything else lists it last).
        expect(numbers).toHaveLength(3);
        expect([...numbers].sort((a, b) => a - b)).toEqual([spec.base[0], spec.base[1], spec.h].sort((a, b) => a - b));
      }
    }
  });
});

describe('recommendPacking', () => {
  it('returns an empty plan for an empty order', () => {
    const plan = recommendPacking([]);
    expect(plan.packages).toEqual([]);
    expect(plan.planLabel).toBe('—');
    expect(plan.manualReview).toBe(false);
    expect(plan.totalWeightKg).toBe(0);
  });

  it('fits a single small plate in gabaryt A', () => {
    const plan = recommendPacking(['t14']);
    expect(plan.planLabel).toBe('A');
    expect(plan.packages).toHaveLength(1);
    expect(plan.packages[0].itemIds).toEqual(['t14']);
    expect(plan.confidence).toBe('high');
    assertInvariants(plan);
  });

  it('fits a single medium plate in gabaryt A', () => {
    // s12 / s23 were real single-item orders.
    expect(recommendPacking(['s12']).planLabel).toBe('A');
    expect(recommendPacking(['s23']).planLabel).toBe('A');
  });

  it('needs gabaryt B for a mug (too tall for A, upright only)', () => {
    const plan = recommendPacking(['k01']);
    expect(plan.planLabel).toBe('B');
    assertInvariants(plan);
  });

  it('recommends B for a real mixed mug + plates order', () => {
    // Order 7313df3f: kubek + talerzyk + talerz średni.
    const plan = recommendPacking(['k22', 't05', 't20']);
    expect(plan.planLabel).toBe('B');
    expect(packedIds(plan)).toEqual(['k22', 't05', 't20']);
    assertInvariants(plan);
  });

  it('keeps a small vase upright → gabaryt C', () => {
    // v07 (19.5 cm tall + wrap) exceeds the 19 cm B slot standing up.
    const plan = recommendPacking(['v07']);
    expect(plan.planLabel).toBe('C');
    expect(plan.notes.some((n) => n.includes('pionowo'))).toBe(true);
    assertInvariants(plan);
  });

  it('puts a large vase in gabaryt C', () => {
    const plan = recommendPacking(['d06']);
    expect(plan.planLabel).toBe('C');
    assertInvariants(plan);
  });

  it('packs the largest real order (14 items) into a single gabaryt C', () => {
    // Order ed582df0: 6 kubków, 6 talerzy średnich, talerzyk, wazon.
    const ids = ['c03', 'k08', 'k09', 'k12', 'k13', 'k21', 's06', 's09', 's13', 's20', 't01', 't27', 't31', 'v02'];
    const plan = recommendPacking(ids);
    expect(plan.planLabel).toBe('C');
    expect(packedIds(plan)).toEqual([...ids].sort());
    expect(plan.manualReview).toBe(false);
    assertInvariants(plan);
  });

  it('splits an order of four large vases into two C parcels', () => {
    // Four upright wazony-duze (21 × 21 cm footprints) cannot share one 38 × 64 base.
    const plan = recommendPacking(['d06', 'd07', 'd09', 'g01']);
    expect(plan.packages.length).toBeGreaterThan(1);
    expect(plan.planLabel).toBe('2×C');
    expect(plan.confidence).toBe('medium');
    expect(packedIds(plan)).toEqual(['d06', 'd07', 'd09', 'g01']);
    assertInvariants(plan);
  });

  it('flags unknown / retired ids for manual review', () => {
    const plan = recommendPacking(['x01']);
    expect(plan.packages).toEqual([]);
    expect(plan.manualReview).toBe(true);
    expect(plan.confidence).toBe('low');
    expect(plan.warnings.some((w) => w.includes('x01'))).toBe(true);
  });

  it('still packs known items when an unknown id is present', () => {
    const plan = recommendPacking(['x01', 't14']);
    expect(plan.planLabel).toBe('A');
    expect(packedIds(plan)).toEqual(['t14']);
    expect(plan.manualReview).toBe(true);
    assertInvariants(plan);
  });

  it('excludes print cart tokens with a Prodigi note, without manual review', () => {
    const token = encodePrintToken('fap01', { size: '50x70', framed: true, mount: false, frameColour: 'natural' });
    const plan = recommendPacking([token, 'k01']);
    expect(plan.planLabel).toBe('B');
    expect(packedIds(plan)).toEqual(['k01']);
    expect(plan.manualReview).toBe(false);
    expect(plan.notes.some((n) => n.includes('Prodigi'))).toBe(true);
  });

  it('excludes persisted print design ids (order_items store fap01, not the token)', () => {
    const plan = recommendPacking(['fap01', 'k01']);
    expect(plan.planLabel).toBe('B');
    expect(packedIds(plan)).toEqual(['k01']);
    expect(plan.manualReview).toBe(false);
    expect(plan.notes.some((n) => n.includes('fap01') && n.includes('Prodigi'))).toBe(true);
  });

  it('emits a single Prodigi note for multiple print lines', () => {
    const plan = recommendPacking(['fap01', 'fap02', 'fap03']);
    expect(plan.packages).toEqual([]);
    expect(plan.manualReview).toBe(false);
    expect(plan.notes.filter((n) => n.includes('Prodigi'))).toHaveLength(1);
  });

  it('stacks plates at most four high', () => {
    // 6 talerzyki → stacks of 4 + 2; both fit one parcel.
    const ids = ['t01', 't02', 't04', 't05', 't06', 't07'];
    const plan = recommendPacking(ids);
    expect(plan.packages).toHaveLength(1);
    expect(packedIds(plan)).toEqual([...ids].sort());
    assertInvariants(plan);
  });

  it('never exceeds parcel weight or produces unsized parcels for every real paid order', () => {
    // Snapshot of all shippable paid orders from production (2026-06/07).
    const orders: string[][] = [
      ['k22', 't05', 't20'],
      ['t14'],
      ['t02'],
      ['c04', 'k17', 't04', 't09', 't19'],
      ['d10', 'p01', 't15'],
      ['t08', 't11', 't18', 't22'],
      ['c02', 'k24', 't12', 't13'],
      ['v07'],
      ['t21', 't26'],
      ['c01', 't23', 't24'],
      ['k10', 't16'],
      ['t30'],
      ['k10', 't18', 't19', 't22'],
      ['k05'],
      ['t10', 't29'],
      ['s03', 's07', 's21', 't17', 'v03'],
      ['k01', 'k03', 'k14', 'k18'],
      ['k23', 'k27', 's18', 't18', 't19', 't23'],
      ['b02', 'k07', 'k19', 'k20', 'k26', 'p05', 's02', 's05'],
      ['k06', 'k11', 's04', 's11', 's22', 't25', 'v06'],
      ['s23'],
      ['s01', 's10'],
      ['s12'],
      ['c03', 'k08', 'k09', 'k12', 'k13', 'k21', 's06', 's09', 's13', 's20', 't01', 't27', 't31', 'v02'],
    ];
    for (const ids of orders) {
      const plan = recommendPacking(ids);
      expect(plan.manualReview).toBe(false);
      expect(plan.packages.length).toBeGreaterThan(0);
      const known = ids.filter((id) => getProductById(id));
      expect(packedIds(plan)).toEqual([...known].sort());
      assertInvariants(plan);
    }
  });
});
