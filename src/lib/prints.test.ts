import { describe, it, expect, beforeAll } from 'vitest';
import { getPrintById, getPrintDesigns, isVariantAvailable, PRINT_DESIGNS_RAW, registryPrintDesigns } from './prints';
import { ACTIVE_PRINT_CURATION, PRINT_CURATION } from './print-curation';
import { MOUNT_TEMPORARILY_DISABLED } from './print-availability';
import { PRINT_FRAME_COLOURS, PRODIGI_SKU_MAP, variantKey } from './print-cart';
import { DEFAULT_PRINT_PRICING, priceOfVariant } from './print-pricing';
import type { PrintDesign, PrintVariantSelection } from './types';

describe('getPrintDesigns', () => {
  it('projects active designs in approved curation order with padded display numbers', async () => {
    const designs = await getPrintDesigns();
    expect(designs.every(d => d.published)).toBe(true);
    const expectedIds = ACTIVE_PRINT_CURATION.map(({ productId }) => productId);
    expect(designs.map(({ id }) => id)).toEqual(expectedIds);
    expect(designs.map(({ num }) => num)).toEqual(
      Array.from({ length: 39 }, (_, i) => String(i + 1).padStart(2, '0')),
    );
    expect(await getPrintById('fap029')).toMatchObject({ published: false });
    expect(await getPrintById('fap037')).toMatchObject({ published: false });
  });

  it('retains every curated stable ID in raw metadata while exposing only active designs', () => {
    const expectedIds = PRINT_CURATION.map(({ productId }) => productId).sort();
    expect(PRINT_DESIGNS_RAW.map(({ id }) => id).sort()).toEqual(expectedIds);
    expect(registryPrintDesigns().map(({ id }) => id)).toEqual(
      ACTIVE_PRINT_CURATION.map(({ productId }) => productId),
    );
  });
});

describe('getPrintById', () => {
  it('returns undefined for unknown id', async () => {
    expect(await getPrintById('unknown')).toBeUndefined();
  });
});

describe('isVariantAvailable', () => {
  let fap005: PrintDesign;
  beforeAll(async () => {
    fap005 = (await getPrintById('fap005'))!;
  });

  it('accepts valid unframed variant', () => {
    expect(isVariantAvailable(fap005, { size: '30x40', framed: false, mount: false, frameColour: 'none' })).toBe(true);
  });
  it('accepts valid framed+mount variant', () => {
    // fap005's mountAvailable is stored false (2026-08-17 batch has no mount
    // source at all — see registry header), so the accept branch runs against
    // a synthetic mount-capable design — same pattern as the `noMount` fixture
    // below.
    const withMount: PrintDesign = { ...fap005, mountAvailable: true };
    expect(isVariantAvailable(withMount, { size: '50x70', framed: true, mount: true, frameColour: 'natural' })).toBe(true);
  });
  it('rejects unpublished design', () => {
    // No design in the live registry is currently unpublished (all 41
    // corrected and re-published 2026-08-17) — synthesize one to exercise
    // the gate directly rather than depending on a real draft existing.
    const unpublished: PrintDesign = { ...fap005, published: false };
    expect(isVariantAvailable(unpublished, { size: '30x40', framed: false, mount: false, frameColour: 'none' })).toBe(false);
  });
  it('rejects mount when design does not offer it', () => {
    const noMount: PrintDesign = { ...fap005, mountAvailable: false };
    expect(isVariantAvailable(noMount, { size: '30x40', framed: true, mount: true, frameColour: 'black' })).toBe(false);
  });
  it('rejects size not offered by design', () => {
    const small: PrintDesign = { ...fap005, sizes: ['30x40', '50x70'] };
    expect(isVariantAvailable(small, { size: '70x100', framed: false, mount: false, frameColour: 'none' })).toBe(false);
  });
  it('rejects an unpublished design for every variant', () => {
    const unpublished: PrintDesign = { ...fap005, published: false };
    expect(isVariantAvailable(unpublished, { size: '30x40', framed: true, mount: false, frameColour: 'black' })).toBe(false);
    expect(isVariantAvailable(unpublished, { size: '70x100', framed: false, mount: false, frameColour: 'none' })).toBe(false);
  });
  it('rejects framed=false with non-none colour', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isVariantAvailable(fap005, { size: '30x40', framed: false, mount: false, frameColour: 'black' } as any)).toBe(false);
  });
});

/* Temporary (2026-08): passe-partout withdrawn from sale — Prodigi's mount
   execution is unsatisfactory. These canaries pin the withdrawal at both catalog
   read roots and at the exact gate checkout uses; they disappear with the flag. */
describe('temporary passe-partout withdrawal', () => {
  it.runIf(MOUNT_TEMPORARILY_DISABLED)('withdraws mount from every design on both registry roots', async () => {
    const designs = await getPrintDesigns();
    expect(designs.length).toBeGreaterThan(0);
    for (const d of designs) expect(d.mountAvailable, d.id).toBe(false);
    for (const d of registryPrintDesigns()) expect(d.mountAvailable, d.id).toBe(false);
  });

  it.runIf(MOUNT_TEMPORARILY_DISABLED)('rejects a mounted variant at the exact checkout gate', async () => {
    const fap005 = (await getPrintById('fap005'))!;
    expect(
      isVariantAvailable(fap005, { size: '50x70', framed: true, mount: true, frameColour: 'natural' }),
    ).toBe(false);
  });
});

describe('editorialGallery registry self-consistency', () => {
  it('every published design\'s editorialGallery references only its own fap-{NNN}-life-0N images, in order', async () => {
    let checked = 0;
    for (const design of await getPrintDesigns()) {
      if (!design.editorialGallery) continue;
      const match = /^fap(\d{3})$/.exec(design.id);
      expect(match, design.id).not.toBeNull();
      const num3 = match![1];
      expect(design.editorialGallery, design.id).toEqual([
        `/uploads/fap-${num3}-life-01.webp`,
        `/uploads/fap-${num3}-life-02.webp`,
        `/uploads/fap-${num3}-life-03.webp`,
      ]);
      checked++;
    }
    // Guard against a silent green pass if editorialGallery is ever removed
    // from every design.
    expect(checked).toBeGreaterThan(0);
  });
});

describe('published print variant coverage', () => {
  it('has SKU and pricing coverage for every sellable variant', async () => {
    let checked = 0;
    for (const design of await getPrintDesigns()) {
      for (const size of design.sizes) {
        // Mirror sellable axes directly: mount only when the design offers it,
        // so the sweep never generates a combo that isVariantAvailable must skip.
        const selections: PrintVariantSelection[] = [
          { size, framed: false, mount: false, frameColour: 'none' },
          ...PRINT_FRAME_COLOURS.flatMap((frameColour) => {
            const framed: PrintVariantSelection[] = [{ size, framed: true, mount: false, frameColour }];
            if (design.mountAvailable) framed.push({ size, framed: true, mount: true, frameColour });
            return framed;
          }),
        ];

        for (const sel of selections) {
          if (!isVariantAvailable(design, sel)) continue;
          const key = variantKey(sel);
          expect(PRODIGI_SKU_MAP[key], `${design.id} ${key}`).toBeDefined();
          expect(priceOfVariant(sel, 'pln', DEFAULT_PRINT_PRICING), `${design.id} ${key} PLN`).toBeGreaterThan(0);
          expect(priceOfVariant(sel, 'eur', DEFAULT_PRINT_PRICING), `${design.id} ${key} EUR`).toBeGreaterThan(0);
          expect(priceOfVariant(sel, 'gbp', DEFAULT_PRINT_PRICING), `${design.id} ${key} GBP`).toBeGreaterThan(0);
          checked++;
        }
      }
    }
    // Guard against a silent green pass: if availability rules change such that
    // nothing is exercised, fail loudly instead of reporting vacuous coverage.
    expect(checked).toBeGreaterThan(0);
  });
});
