import { describe, it, expect } from 'vitest';
import {
  deriveSourceProfile,
  uploadStemFor,
  buildPrepareConfig,
  buildPrintDesignEntry,
  defaultMasterFolder,
  expectedVariantDimensions,
  onboardingRowSchema,
  onboardingManifestSchema,
  ONBOARD_BACKGROUND,
  ONBOARD_FORMAT,
  ONBOARD_LAYOUT,
  FULL_AXES,
  type PosterOnboardingRow,
  type FullBleedOnboardingRow,
} from './print-assets-onboard';

const ROW: PosterOnboardingRow = {
  id: 'fap005',
  title: 'Cumulonimbus 07',
  style: 'poster',
  incomingFile: 'cumulonimbus-07.jpg',
  sizes: ['30x40', '50x70', '70x100'],
  frameColours: ['black', 'natural', 'brown'],
  mountAvailable: true,
  noteIndex: 4,
};

const FULL_BLEED_ROW: FullBleedOnboardingRow = {
  id: 'fap005',
  title: 'Painting 01',
  style: 'fullBleed',
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

describe('defaultMasterFolder', () => {
  it('maps fap(NN+4) back to NN, zero-padded', () => {
    expect(defaultMasterFolder('fap005')).toBe('01');
    expect(defaultMasterFolder('fap047')).toBe('43');
    expect(defaultMasterFolder('fap010')).toBe('06');
  });

  it('throws on an id that does not map to a positive painting number', () => {
    expect(() => defaultMasterFolder('fap004')).toThrow();
    expect(() => defaultMasterFolder('fap001')).toThrow();
  });

  it('throws on an id with no trailing digits', () => {
    expect(() => defaultMasterFolder('fap')).toThrow();
  });
});

describe('buildPrepareConfig', () => {
  it('builds the exact poster PrepareConfig shape from a manifest row', () => {
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

  it('builds the fullBleed PrepareConfig shape, deriving masterFolder from id', () => {
    const sourceProfile = deriveSourceProfile(FULL_AXES.sizes);
    const config = buildPrepareConfig(FULL_BLEED_ROW, sourceProfile);
    expect(config).toEqual({
      product: 'fap005',
      mode: 'fullBleed',
      format: 'jpg',
      sources: {
        '3x4': 'design/uploads/master-images-prints/01/01__3x4.jpg',
        '5x7': 'design/uploads/master-images-prints/01/01__5x7.jpg',
        '7x10': 'design/uploads/master-images-prints/01/01__7x10.jpg',
        '2x3': 'design/uploads/master-images-prints/01/01__2x3.jpg',
      },
      gallery: { hero: { sourceProfile: '8400x12000', uploadStem: 'fap-005' } },
    });
  });

  it('honours an explicit masterFolder override', () => {
    const sourceProfile = deriveSourceProfile(FULL_AXES.sizes);
    const config = buildPrepareConfig({ ...FULL_BLEED_ROW, masterFolder: '99' }, sourceProfile);
    expect(config).toMatchObject({ sources: { '3x4': 'design/uploads/master-images-prints/99/99__3x4.jpg' } });
  });
});

describe('buildPrintDesignEntry', () => {
  it('builds an unpublished PrintDesign entry from a poster manifest row', () => {
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

  it('builds a full-axes unpublished PrintDesign entry from a fullBleed manifest row', () => {
    expect(buildPrintDesignEntry(FULL_BLEED_ROW)).toEqual({
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

  it('enumerates all 21 variants for FULL_AXES (fullBleed rows)', () => {
    expect(expectedVariantDimensions(FULL_AXES)).toHaveLength(21);
  });
});

describe('onboardingRowSchema / onboardingManifestSchema', () => {
  it('accepts a well-formed poster row', () => {
    expect(onboardingRowSchema.safeParse(ROW).success).toBe(true);
  });

  it('accepts a well-formed fullBleed row, with and without masterFolder', () => {
    expect(onboardingRowSchema.safeParse(FULL_BLEED_ROW).success).toBe(true);
    expect(onboardingRowSchema.safeParse({ ...FULL_BLEED_ROW, masterFolder: '01' }).success).toBe(true);
  });

  it('rejects an id that does not match fapNNN', () => {
    expect(onboardingRowSchema.safeParse({ ...ROW, id: 'fap5' }).success).toBe(false);
    expect(onboardingRowSchema.safeParse({ ...FULL_BLEED_ROW, id: 'fap5' }).success).toBe(false);
  });

  it('rejects an unrecognized size or frame colour', () => {
    expect(onboardingRowSchema.safeParse({ ...ROW, sizes: ['a4'] }).success).toBe(false);
    expect(onboardingRowSchema.safeParse({ ...ROW, frameColours: ['white'] }).success).toBe(false);
  });

  it('rejects a malformed masterFolder', () => {
    expect(onboardingRowSchema.safeParse({ ...FULL_BLEED_ROW, masterFolder: '1' }).success).toBe(false);
    expect(onboardingRowSchema.safeParse({ ...FULL_BLEED_ROW, masterFolder: 'ab' }).success).toBe(false);
  });

  it('rejects an omitted masterFolder that does not resolve under NN -> fap(NN+4)', () => {
    // fap004 -> NN=0, not a valid painting number, and no override is given.
    expect(onboardingRowSchema.safeParse({ ...FULL_BLEED_ROW, id: 'fap004' }).success).toBe(false);
  });

  it('accepts an unresolvable id when masterFolder is given explicitly', () => {
    expect(onboardingRowSchema.safeParse({ ...FULL_BLEED_ROW, id: 'fap004', masterFolder: '01' }).success).toBe(true);
  });

  it('rejects an unrecognized style', () => {
    expect(onboardingRowSchema.safeParse({ ...ROW, style: 'bogus' }).success).toBe(false);
  });

  it('rejects a poster row missing style', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { style: _style, ...withoutStyle } = ROW;
    expect(onboardingRowSchema.safeParse(withoutStyle).success).toBe(false);
  });

  it('rejects a poster field on a fullBleed row (strict per-branch schema)', () => {
    expect(onboardingRowSchema.safeParse({ ...FULL_BLEED_ROW, incomingFile: 'x.jpg' }).success).toBe(false);
    expect(onboardingRowSchema.safeParse({ ...FULL_BLEED_ROW, sizes: ['30x40'] }).success).toBe(false);
  });

  it('rejects a fullBleed field on a poster row', () => {
    expect(onboardingRowSchema.safeParse({ ...ROW, masterFolder: '01' }).success).toBe(false);
  });

  it('rejects an unknown extra field (strict)', () => {
    expect(onboardingRowSchema.safeParse({ ...ROW, extra: true }).success).toBe(false);
  });

  it('requires a non-empty array of rows', () => {
    expect(onboardingManifestSchema.safeParse([]).success).toBe(false);
    expect(onboardingManifestSchema.safeParse([ROW]).success).toBe(true);
    expect(onboardingManifestSchema.safeParse([FULL_BLEED_ROW]).success).toBe(true);
  });
});
