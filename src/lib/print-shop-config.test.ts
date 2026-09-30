import { describe, expect, it } from 'vitest';
import { PRINT_SHOP_CONFIG, shopColoursFor, validatePrintShopConfig } from './print-shop-config';
import { registryContentPrintDesigns, registryPrintDesigns } from './prints';

const valid = { schemaVersion: 1, featured: ['fap001'], newCount: 12, designs: { fap001: { colours: ['blue'], reviewed: false } } };

describe('validatePrintShopConfig', () => {
  it('accepts a well-formed config', () => {
    expect(validatePrintShopConfig(valid, ['fap001'])).toEqual(valid);
  });

  it.each([
    ['non-object', null],
    ['wrong schemaVersion', { ...valid, schemaVersion: 2 }],
    ['duplicate featured ids', { ...valid, featured: ['fap001', 'fap001'] }],
    ['negative newCount', { ...valid, newCount: -1 }],
    ['fractional newCount', { ...valid, newCount: 1.5 }],
    ['bad design id', { ...valid, designs: { nope: { colours: ['blue'], reviewed: false } } }],
    ['unknown colour', { ...valid, designs: { fap001: { colours: ['neon'], reviewed: false } } }],
    ['duplicate colours', { ...valid, designs: { fap001: { colours: ['blue', 'blue'], reviewed: false } } }],
    ['missing reviewed flag', { ...valid, designs: { fap001: { colours: ['blue'] } } }],
  ])('rejects %s', (_label, input) => {
    expect(() => validatePrintShopConfig(input)).toThrow(/Invalid print shop config/);
  });

  it('rejects ids outside the registry when known ids are given', () => {
    expect(() => validatePrintShopConfig(valid, ['fap002'])).toThrow(/unknown design id/);
    expect(() => validatePrintShopConfig({ ...valid, designs: {}, featured: ['fap009'] }, ['fap001'])).toThrow(/not a known design/);
  });
});

describe('committed config/print-shop.json', () => {
  it('only references designs that exist in the registry', () => {
    expect(() => validatePrintShopConfig(PRINT_SHOP_CONFIG, registryContentPrintDesigns().map((d) => d.id))).not.toThrow();
  });

  // Onboarding gate: run `npm run print-assets:facets` after adding designs.
  it('gives every published design at least one colour', () => {
    const missing = registryPrintDesigns().filter((d) => shopColoursFor(d.id).length === 0).map((d) => d.id);
    expect(missing, 'run `npm run print-assets:facets` for these designs').toEqual([]);
  });

  it('only pins published designs as featured', () => {
    const published = new Set(registryPrintDesigns().map((d) => d.id));
    expect(PRINT_SHOP_CONFIG.featured.filter((id) => !published.has(id))).toEqual([]);
  });
});

describe('shopColoursFor', () => {
  it('returns [] for a design with no entry', () => {
    expect(shopColoursFor('fap999')).toEqual([]);
  });
});
