import { describe, it, expect } from 'vitest';
import {
  isPrintToken,
  variantKey,
  encodePrintToken,
  decodePrintToken,
  variantLabel,
} from './print-cart';
import type { PrintVariantSelection } from './types';

const sel: PrintVariantSelection = { size: 'a3', paper: 'satin', frame: 'oak' };

describe('isPrintToken', () => {
  it('distinguishes print tokens from bare ceramic ids', () => {
    expect(isPrintToken('print:fap01:a3:satin:oak')).toBe(true);
    expect(isPrintToken('k01')).toBe(false);
    expect(isPrintToken('printer')).toBe(false); // no colon → not a token
  });
});

describe('variantKey', () => {
  it('joins the three axes with colons', () => {
    expect(variantKey(sel)).toBe('a3:satin:oak');
  });
});

describe('encode / decode round-trip', () => {
  it('encodes then decodes back to the same design + selection', () => {
    const token = encodePrintToken('fap01', sel);
    expect(token).toBe('print:fap01:a3:satin:oak');
    expect(decodePrintToken(token)).toEqual({ designId: 'fap01', sel });
  });
});

describe('decodePrintToken rejects malformed input', () => {
  it('rejects a bare ceramic id', () => {
    expect(decodePrintToken('k01')).toBeNull();
  });

  it('rejects the wrong number of segments', () => {
    expect(decodePrintToken('print:fap01:a3:satin')).toBeNull();
    expect(decodePrintToken('print:fap01:a3:satin:oak:extra')).toBeNull();
  });

  it('rejects an empty design id', () => {
    expect(decodePrintToken('print::a3:satin:oak')).toBeNull();
  });

  it('rejects an out-of-enum size, paper, or frame', () => {
    expect(decodePrintToken('print:fap01:a5:satin:oak')).toBeNull();
    expect(decodePrintToken('print:fap01:a3:glossy:oak')).toBeNull();
    expect(decodePrintToken('print:fap01:a3:satin:gold')).toBeNull();
  });
});

describe('variantLabel', () => {
  it('renders a localized one-line label', () => {
    expect(variantLabel(sel, 'pl')).toBe('A3 · satyna · rama dębowa');
    expect(variantLabel(sel, 'en')).toBe('A3 · satin · oak frame');
    expect(variantLabel({ size: 'a4', paper: 'matte', frame: 'none' }, 'es')).toBe('A4 · mate · sin marco');
  });

  it('falls back to Polish for an unknown locale', () => {
    expect(variantLabel(sel, 'de')).toBe(variantLabel(sel, 'pl'));
  });
});
