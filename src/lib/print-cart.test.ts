import { describe, it, expect } from 'vitest';
import {
  encodePrintToken, decodePrintToken, isPrintToken,
  variantKey, variantLabel, PRODIGI_SKU_MAP,
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
});

describe('variantLabel', () => {
  it('labels an unframed print in Polish', () => {
    const sel = { size: '30x40' as const, framed: false, mount: false, frameColour: 'none' as const };
    expect(variantLabel(sel, 'pl')).toBe('30×40 cm · bez ramy');
  });
  it('labels a framed+mount print in English', () => {
    const sel = { size: '50x70' as const, framed: true, mount: true, frameColour: 'natural' as const };
    expect(variantLabel(sel, 'en')).toBe('50×70 cm · rama natural · + mount');
  });
});

describe('PRODIGI_SKU_MAP', () => {
  it('has exactly 21 entries', () => {
    expect(Object.keys(PRODIGI_SKU_MAP)).toHaveLength(21);
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
