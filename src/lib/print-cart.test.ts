import { describe, it, expect } from 'vitest';
import {
  encodePrintToken, decodePrintToken, isPrintToken,
  variantKey, variantLabel, printVariantButtonState, PRODIGI_SKU_MAP,
  PRINT_SIZES, PRINT_FRAME_COLOURS,
} from './print-cart';

describe('isPrintToken', () => {
  it('identifies print tokens', () => {
    expect(isPrintToken('print:fap01:50x70:true:true:natural')).toBe(true);
  });
  it('rejects ceramic ids', () => {
    expect(isPrintToken('k01')).toBe(false);
  });
});

describe('encodePrintToken / decodePrintToken round-trip', () => {
  const sel = { size: '50x70' as const, framed: true, mount: true, frameColour: 'natural' as const };
  it('round-trips a framed+mount variant', () => {
    const token = encodePrintToken('fap01', sel);
    expect(token).toBe('print:fap01:50x70:true:true:natural');
    expect(decodePrintToken(token)).toEqual({ designId: 'fap01', sel });
  });
  it('round-trips an unframed variant', () => {
    const unframed = { size: '30x40' as const, framed: false, mount: false, frameColour: 'none' as const };
    expect(decodePrintToken(encodePrintToken('fap01', unframed))).toEqual({ designId: 'fap01', sel: unframed });
  });
});

describe('decodePrintToken validation', () => {
  it('rejects unknown size', () => {
    expect(decodePrintToken('print:fap01:a3:true:false:black')).toBeNull();
  });
  it('rejects wrong part count', () => {
    expect(decodePrintToken('print:fap01:50x70:true:black')).toBeNull();
  });
  it('rejects framed=false with a colour', () => {
    expect(decodePrintToken('print:fap01:50x70:false:false:black')).toBeNull();
  });
  it('rejects framed=true with none colour', () => {
    expect(decodePrintToken('print:fap01:50x70:true:false:none')).toBeNull();
  });
  it('rejects mount=true without a frame', () => {
    expect(decodePrintToken('print:fap01:50x70:false:true:none')).toBeNull();
  });
});

describe('decodePrintToken — legacy white colour migration (2026-07-19 colour swap)', () => {
  it('decodes a pre-migration :white token as brown instead of dropping it', () => {
    const sel = { size: '50x70' as const, framed: true, mount: false, frameColour: 'brown' as const };
    expect(decodePrintToken('print:fap01:50x70:true:false:white')).toEqual({ designId: 'fap01', sel });
  });

  it('decodes a pre-migration :white token with a mount as brown', () => {
    const sel = { size: '30x40' as const, framed: true, mount: true, frameColour: 'brown' as const };
    expect(decodePrintToken('print:fap01:30x40:true:true:white')).toEqual({ designId: 'fap01', sel });
  });
});

describe('variantLabel', () => {
  it('labels an unframed print in Polish', () => {
    const sel = { size: '30x40' as const, framed: false, mount: false, frameColour: 'none' as const };
    expect(variantLabel(sel, 'pl')).toBe('30×40 cm · bez ramy');
  });
  it('labels a framed+mount print in English', () => {
    const sel = { size: '50x70' as const, framed: true, mount: true, frameColour: 'natural' as const };
    expect(variantLabel(sel, 'en')).toBe('50×70 cm · frame light brown · + mount');
  });
  it('labels a framed print in Polish', () => {
    const sel = { size: '50x70' as const, framed: true, mount: false, frameColour: 'black' as const };
    expect(variantLabel(sel, 'pl')).toBe('50×70 cm · rama czarna');
  });
});

describe('printVariantButtonState', () => {
  const sel = { size: '30x40' as const, framed: false, mount: false, frameColour: 'none' as const };

  it('enables a variant whose key is in usableVariantKeys', () => {
    expect(printVariantButtonState({
      structurallyAvailable: true, usableVariantKeys: [variantKey(sel)], sel, inCart: false,
    })).toBe('add');
  });

  it('gates a variant whose key is NOT in usableVariantKeys (asset unavailable)', () => {
    expect(printVariantButtonState({
      structurallyAvailable: true, usableVariantKeys: ['50x70:false:false:none'], sel, inCart: false,
    })).toBe('disabledAsset');
  });

  it('never gates when usableVariantKeys is undefined (registry mode / no rows / fetch error)', () => {
    expect(printVariantButtonState({
      structurallyAvailable: true, usableVariantKeys: undefined, sel, inCart: false,
    })).toBe('add');
  });

  it('gates every variant when usableVariantKeys is an empty array (nothing usable)', () => {
    expect(printVariantButtonState({
      structurallyAvailable: true, usableVariantKeys: [], sel, inCart: false,
    })).toBe('disabledAsset');
  });

  it('keeps the remove path reachable when an in-cart variant becomes non-usable', () => {
    expect(printVariantButtonState({
      structurallyAvailable: true, usableVariantKeys: [], sel, inCart: true,
    })).toBe('remove');
  });

  it('reports structural unavailable (not asset) when the variant is not offered', () => {
    expect(printVariantButtonState({
      structurallyAvailable: false, usableVariantKeys: undefined, sel, inCart: false,
    })).toBe('disabledStructural');
  });
});

describe('PRODIGI_SKU_MAP', () => {
  // 1 unframed + 2 framed states (with/without mount) per colour, per size.
  const expectedCount = PRINT_SIZES.length * (1 + PRINT_FRAME_COLOURS.length * 2);
  it('covers every size × frame × mount × colour variant', () => {
    expect(Object.keys(PRODIGI_SKU_MAP)).toHaveLength(expectedCount);
  });
  it('maps unframed 30x40 to FAP-12X16', () => {
    expect(PRODIGI_SKU_MAP[variantKey({ size: '30x40', framed: false, mount: false, frameColour: 'none' })].sku)
      .toBe('GLOBAL-FAP-12X16');
  });
  it('maps framed+mount 50x70 to CFPM-20X28 with correct print area', () => {
    const entry = PRODIGI_SKU_MAP[variantKey({ size: '50x70', framed: true, mount: true, frameColour: 'black' })];
    expect(entry.sku).toBe('GLOBAL-CFPM-20X28');
    expect(entry.printAreaPx).toEqual({ w: 4800, h: 7200 });
  });
});

describe('PRODIGI_SKU_MAP — brown replaces white (2026-07-19 colour swap)', () => {
  it('maps brown with per-colour print areas (30x40 CFP exception is black-only)', () => {
    expect(PRODIGI_SKU_MAP['30x40:true:false:brown']).toEqual({
      sku: 'GLOBAL-CFP-12X16',
      printAreaPx: { w: 3600, h: 4800 },
    });
    expect(PRODIGI_SKU_MAP['30x40:true:true:brown']).toEqual({
      sku: 'GLOBAL-CFPM-12X16',
      printAreaPx: { w: 2400, h: 3600 },
    });
    expect(PRODIGI_SKU_MAP['50x70:true:false:brown']).toEqual({
      sku: 'GLOBAL-CFP-20X28',
      printAreaPx: { w: 6000, h: 8400 },
    });
    expect(PRODIGI_SKU_MAP['70x100:true:false:brown']).toEqual({
      sku: 'GLOBAL-CFP-28X40',
      printAreaPx: { w: 8400, h: 12000 },
    });
  });

  it('has no white keys and still exactly 21 entries', () => {
    expect(Object.keys(PRODIGI_SKU_MAP).some((k) => k.endsWith(':white'))).toBe(false);
    expect(Object.keys(PRODIGI_SKU_MAP)).toHaveLength(21);
  });
});
