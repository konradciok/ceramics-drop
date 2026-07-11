import { describe, it, expect } from 'vitest';
import { validateProdigiDimensions } from './print-dimensions';
import type { ProdigiProductResponse } from '../server/prodigi/types';
import { PRODIGI_SKU_MAP } from './print-cart';

/** Build a minimal product response with the given variant dims (positional). */
function product(sku: string, dims: Array<{ w: number; h: number }>): ProdigiProductResponse {
  return {
    product: {
      sku,
      attributes: [],
      variants: dims.map((d) => ({
        printAreaSizes: {
          default: { horizontalResolution: d.w, verticalResolution: d.h },
        },
      })),
    },
  };
}

const CFP_12X16 = 'GLOBAL-CFP-12X16';

describe('validateProdigiDimensions', () => {
  it('is clean when all variants agree and match a contract dim', () => {
    // FAP-12X16 contract has a single dim {3600,4800}; all variants share it.
    const report = validateProdigiDimensions(product('GLOBAL-FAP-12X16', [
      { w: 3600, h: 4800 },
      { w: 3600, h: 4800 },
    ]));
    expect(report.intraSkuDisagreement).toBe(false);
    expect(report.contractMismatches).toEqual([]);
    expect(report.unknownSku).toBe(false);
    expect(report.hasProblem).toBe(false);
    expect(report.variants).toHaveLength(2);
  });

  it('flags intra-SKU disagreement (the CFP-12X16 black/natural shape)', () => {
    // Contract: black/white → 3614×4795, natural → 3600×4800.
    const report = validateProdigiDimensions(
      product(CFP_12X16, [
        { w: 3614, h: 4795 }, // black/white
        { w: 3614, h: 4795 }, // black/white
        { w: 3600, h: 4800 }, // natural — differs
      ]),
    );
    expect(report.intraSkuDisagreement).toBe(true);
    // Both dims exist in the contract, so no contract mismatch — only disagreement.
    expect(report.contractMismatches).toEqual([]);
    expect(report.hasProblem).toBe(true);
    expect(report.contractDims).toContainEqual({ w: 3614, h: 4795 });
    expect(report.contractDims).toContainEqual({ w: 3600, h: 4800 });
  });

  it('flags a contract mismatch when Prodigi reports an unknown dim', () => {
    const report = validateProdigiDimensions(
      product(CFP_12X16, [{ w: 9999, h: 9999 }]),
    );
    expect(report.contractMismatches).toHaveLength(1);
    expect(report.contractMismatches[0]).toEqual({ variantIndex: 0, prodigi: { w: 9999, h: 9999 } });
    // Lock the slimmer shape — guards against re-adding the deduped contractDims field.
    expect(report.contractMismatches[0]).not.toHaveProperty('contractDims');
    expect(report.hasProblem).toBe(true);
  });

  it('handles a variant combination the contract does not know about (unknown SKU)', () => {
    const report = validateProdigiDimensions(
      product('GLOBAL-NOPE-99X99', [{ w: 100, h: 100 }]),
    );
    expect(report.unknownSku).toBe(true);
    expect(report.contractDims).toEqual([]);
    expect(report.contractMismatches).toEqual([]); // nothing to compare against
    expect(report.hasProblem).toBe(true);
  });

  it('respects an explicit contract override', () => {
    const custom = { 'x:0:0:none': { sku: 'X-1', printAreaPx: { w: 10, h: 20 } } };
    const report = validateProdigiDimensions(product('X-1', [{ w: 10, h: 20 }]), custom);
    expect(report.unknownSku).toBe(false);
    expect(report.hasProblem).toBe(false);
  });

  it('agrees with the real PRODIGI_SKU_MAP for a known agreeing SKU', () => {
    // CFPM-20X28: all three frame colours map to the same dim in the contract.
    const entry = Object.entries(PRODIGI_SKU_MAP).find(([, v]) => v.sku === 'GLOBAL-CFPM-20X28')!;
    const { printAreaPx } = entry[1];
    const report = validateProdigiDimensions(
      product('GLOBAL-CFPM-20X28', [printAreaPx, printAreaPx, printAreaPx]),
    );
    expect(report.hasProblem).toBe(false);
  });
});
