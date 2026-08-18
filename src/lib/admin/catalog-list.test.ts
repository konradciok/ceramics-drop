import { describe, it, expect } from 'vitest';
import { buildCatalogSeed } from '@/lib/catalog/seed';
import { registryProducts } from '@/lib/products';
import { PRINT_DESIGNS } from '@/lib/prints';
import type { Piece } from '@/lib/admin/data';
import { assembleProductRows } from './catalog-list';

const seed = buildCatalogSeed();
const catalog = { products: seed.products, variants: seed.variants };

function piece(overrides: Partial<Piece> & Pick<Piece, 'product_id' | 'status'>): Piece {
  return {
    reserved_until: null,
    order_id: null,
    showroom: false,
    showroom_entered_at: null,
    reservedExpired: false,
    ...overrides,
  };
}

describe('assembleProductRows', () => {
  it('produces one row per catalogue product (ceramics + prints)', () => {
    const rows = assembleProductRows(catalog, new Map());
    expect(rows).toHaveLength(registryProducts().length + PRINT_DESIGNS.length);
  });

  it('defaults an untouched ceramic to active, 1/1, one variant', () => {
    const rows = assembleProductRows(catalog, new Map());
    const k01 = rows.find((r) => r.id === 'k01')!;
    expect(k01).toMatchObject({
      type: 'ceramic',
      status: 'active',
      purchasable: true,
      variantCount: 1,
      stockLabel: '1/1',
      priceLabel: '95 zł',
    });
    expect(k01.title).toContain('Nº01');
  });

  it('overlays sold state from piece_state', () => {
    const rows = assembleProductRows(catalog, new Map([['k01', piece({ product_id: 'k01', status: 'sold' })]]));
    const k01 = rows.find((r) => r.id === 'k01')!;
    expect(k01.status).toBe('sold');
    expect(k01.purchasable).toBe(false);
    expect(k01.stockLabel).toBe('0/1');
  });

  it('marks showroom ceramics as visible-but-not-purchasable', () => {
    const rows = assembleProductRows(
      catalog,
      new Map([['k01', piece({ product_id: 'k01', status: 'available', showroom: true })]]),
    );
    const k01 = rows.find((r) => r.id === 'k01')!;
    expect(k01).toMatchObject({ status: 'showroom', purchasable: false, stockLabel: '0/1' });
  });

  it('shows a hold hint in the stock column for a live reservation', () => {
    const k01 = assembleProductRows(
      catalog,
      new Map([['k01', piece({ product_id: 'k01', status: 'reserved' })]]),
    ).find((r) => r.id === 'k01')!;
    expect(k01.status).toBe('reserved');
    expect(k01.stockLabel).toBe('1/1 · hold');
  });

  it('treats an active product with no variants as out of stock (partial backfill guard)', () => {
    const synthetic = {
      products: [
        { ...catalog.products[0], id: 'zz02', type: 'ceramic' as const, category_slug: 'kubki' as const, status: 'active' as const },
      ],
      variants: [],
    };
    const row = assembleProductRows(synthetic, new Map())[0];
    expect(row.status).toBe('out_of_stock');
    expect(row.purchasable).toBe(false);
  });

  it('treats an active product whose every variant is inactive as out of stock', () => {
    const synthetic = {
      products: [
        { ...catalog.products[0], id: 'zz01', type: 'ceramic' as const, category_slug: 'kubki' as const, status: 'active' as const },
      ],
      variants: [
        { ...catalog.variants[0], product_id: 'zz01', active: false, track_inventory: false },
      ],
    };
    const row = assembleProductRows(synthetic, new Map())[0];
    expect(row.status).toBe('out_of_stock');
  });

  it('shows a live reservation but treats an expired hold as available', () => {
    const live = assembleProductRows(
      catalog,
      new Map([['k01', piece({ product_id: 'k01', status: 'reserved' })]]),
    ).find((r) => r.id === 'k01')!;
    expect(live.status).toBe('reserved');

    const expired = assembleProductRows(
      catalog,
      new Map([['k01', piece({ product_id: 'k01', status: 'reserved', reservedExpired: true })]]),
    ).find((r) => r.id === 'k01')!;
    expect(expired.status).toBe('active');
  });

  it('marks prints as POD with many variants and a "from" price', () => {
    const rows = assembleProductRows(catalog, new Map());
    const fap005 = rows.find((r) => r.id === 'fap005')!;
    expect(fap005.type).toBe('print');
    expect(fap005.stockLabel).toBe('POD');
    // No mount source in the 2026-08-17 batch (mountAvailable: false as raw
    // truth): 3 sizes × (1 unframed + 3 colours) = 12.
    expect(fap005.variantCount).toBe(12);
    expect(fap005.priceLabel).toMatch(/^od \d+ zł$/);
    // An unpublished design lands as a draft. All 41 current designs are
    // published (2026-08-17) — synthesize a draft row rather than depending
    // on a real one existing.
    const withDraft = {
      products: catalog.products.map((p) => (p.id === 'fap005' ? { ...p, status: 'draft' as const } : p)),
      variants: catalog.variants,
    };
    expect(assembleProductRows(withDraft, new Map()).find((r) => r.id === 'fap005')!.status).toBe('draft');
  });

  it('sorts by category order then display number, prints last', () => {
    const rows = assembleProductRows(catalog, new Map());
    // First row is a kubek (first category), last rows are prints.
    expect(rows[0].category).toBe('kubki');
    expect(rows[rows.length - 1].category).toBe('fine-art-prints');
  });

  it('sorts prints numerically by num, not lexicographically', () => {
    const rows = assembleProductRows(catalog, new Map());
    const printRows = rows.filter((r) => r.category === 'fine-art-prints');
    // A string sort would put fap010 (num '10') before fap002 (num '2').
    // Numeric sort never regresses: each row's num is >= the previous row's.
    for (let i = 1; i < printRows.length; i++) {
      expect(Number(printRows[i].num)).toBeGreaterThanOrEqual(Number(printRows[i - 1].num));
    }
  });
});
