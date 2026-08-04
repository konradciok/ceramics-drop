import { describe, it, expect } from 'vitest';
import {
  deriveSourceProfile,
  uploadStemFor,
  buildPrepareConfig,
  buildPrintDesignEntry,
  expectedVariantDimensions,
  onboardingRowSchema,
  onboardingManifestSchema,
  ONBOARD_BACKGROUND,
  ONBOARD_FORMAT,
  ONBOARD_LAYOUT,
  type OnboardingRow,
} from './print-assets-onboard';

const ROW: OnboardingRow = {
  id: 'fap005',
  title: 'Cumulonimbus 07',
  incomingFile: 'cumulonimbus-07.jpg',
  sizes: ['30x40', '50x70', '70x100'],
  frameColours: ['black', 'natural', 'brown'],
  mountAvailable: true,
  noteIndex: 4,
};

describe('deriveSourceProfile', () => {
  it('picks the 70x100 unframed profile when a design sells up to 70x100 (fap01/fap03 shape)', () => {
    expect(deriveSourceProfile(['30x40', '50x70', '70x100'])).toEqual({ profileKey: '8400x12000', w: 8400, h: 12000 });
  });

  it('picks the 50x70 unframed profile when a design sells only up to 50x70 (fap02 shape)', () => {
    expect(deriveSourceProfile(['30x40', '50x70'])).toEqual({ profileKey: '6000x8400', w: 6000, h: 8400 });
  });

  it('is order-independent — the largest size wins regardless of array order', () => {
    expect(deriveSourceProfile(['70x100', '30x40'])).toEqual({ profileKey: '8400x12000', w: 8400, h: 12000 });
  });

  it('throws on an empty sizes list', () => {
    expect(() => deriveSourceProfile([])).toThrow();
  });
});

describe('uploadStemFor', () => {
  it('inserts a dash between the letter prefix and digits', () => {
    expect(uploadStemFor('fap005')).toBe('fap-005');
    expect(uploadStemFor('fap01')).toBe('fap-01');
  });

  it('throws on an id with no trailing digits', () => {
    expect(() => uploadStemFor('fap')).toThrow();
  });
});

describe('buildPrepareConfig', () => {
  it('builds the exact PrepareConfig shape from a manifest row', () => {
    const sourceProfile = deriveSourceProfile(ROW.sizes);
    const config = buildPrepareConfig(ROW, sourceProfile);
    expect(config).toEqual({
      product: 'fap005',
      artwork: 'design/print-assets/fap005/artwork-master.jpg',
      background: ONBOARD_BACKGROUND,
      format: ONBOARD_FORMAT,
      layout: ONBOARD_LAYOUT,
      signature: { svg: 'design/print-assets/fap005/signature.svg' },
      gallery: { hero: { sourceProfile: '8400x12000', uploadStem: 'fap-005' } },
    });
  });
});

describe('buildPrintDesignEntry', () => {
  it('builds an unpublished PrintDesign entry from a manifest row', () => {
    expect(buildPrintDesignEntry(ROW)).toEqual({
      id: 'fap005',
      category: 'fine-art-prints',
      num: '005',
      image: '/uploads/fap-005.webp',
      noteIndex: 4,
      sizes: ['30x40', '50x70', '70x100'],
      frameColours: ['black', 'natural', 'brown'],
      mountAvailable: true,
      published: false,
    });
  });
});

describe('expectedVariantDimensions', () => {
  it('enumerates unframed + framed(no mount) + framed+mount for every size×colour (fap01 shape)', () => {
    const dims = expectedVariantDimensions(ROW);
    // 3 sizes × (1 unframed + 3 colours × (framed-no-mount + framed+mount)) = 3 × 7 = 21
    expect(dims).toHaveLength(21);
    expect(dims.map((d) => d.variantKey)).toContain('70x100:false:false:none');
    expect(dims.map((d) => d.variantKey)).toContain('70x100:true:true:brown');
    const unframed70x100 = dims.find((d) => d.variantKey === '70x100:false:false:none')!;
    expect(unframed70x100).toEqual({ variantKey: '70x100:false:false:none', w: 8400, h: 12000 });
  });

  it('omits framed+mount variants when mountAvailable is false (fap02 shape)', () => {
    const dims = expectedVariantDimensions({
      sizes: ['30x40', '50x70'],
      frameColours: ['black', 'natural'],
      mountAvailable: false,
    });
    // 2 sizes × (1 unframed + 2 colours × 1 framed-no-mount) = 2 × 3 = 6
    expect(dims).toHaveLength(6);
    expect(dims.some((d) => d.variantKey.includes(':true:true:'))).toBe(false);
  });
});

describe('onboardingRowSchema / onboardingManifestSchema', () => {
  it('accepts a well-formed row', () => {
    expect(onboardingRowSchema.safeParse(ROW).success).toBe(true);
  });

  it('rejects an id that does not match fapNNN', () => {
    expect(onboardingRowSchema.safeParse({ ...ROW, id: 'fap5' }).success).toBe(false);
  });

  it('rejects an unrecognized size or frame colour', () => {
    expect(onboardingRowSchema.safeParse({ ...ROW, sizes: ['a4'] }).success).toBe(false);
    expect(onboardingRowSchema.safeParse({ ...ROW, frameColours: ['white'] }).success).toBe(false);
  });

  it('rejects an unknown extra field (strict)', () => {
    expect(onboardingRowSchema.safeParse({ ...ROW, extra: true }).success).toBe(false);
  });

  it('requires a non-empty array of rows', () => {
    expect(onboardingManifestSchema.safeParse([]).success).toBe(false);
    expect(onboardingManifestSchema.safeParse([ROW]).success).toBe(true);
  });
});
