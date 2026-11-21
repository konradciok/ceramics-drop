import { describe, expect, it } from 'vitest';
import {
  formatLegacyPrintVariant,
  isRetiredPrintToken,
  legacyPrintName,
} from './legacy-print-lines';

// Shapes copied from real persisted order_items.variant rows (asset fields
// trimmed — the formatter must ignore them).
const FRAMED_BLACK = { kind: 'print', size: '50x70', mount: false, framed: true, frameColour: 'black', prodigiSku: 'GLOBAL-CFP-20X28' };
const FRAMED_NATURAL = { kind: 'print', size: '30x40', mount: false, framed: true, frameColour: 'natural' };
const UNFRAMED = { kind: 'print', size: '70x100', mount: false, framed: false, frameColour: 'none' };
const FRAMED_MOUNTED = { kind: 'print', size: '50x70', mount: true, framed: true, frameColour: 'brown' };

describe('legacy print lines', () => {
  it('names every design that appears in historical orders', () => {
    expect(legacyPrintName('fap001', 'pl')).toBe('Ostrea 01');
    for (const id of ['fap005', 'fap008', 'fap016', 'fap049']) {
      expect(legacyPrintName(id, 'en')).not.toContain(id);
    }
  });

  it('degrades an unknown design to a localised noun plus its id', () => {
    expect(legacyPrintName('fap999', 'pl')).toBe('Odbitka fap999');
    expect(legacyPrintName('fap999', 'de')).toBe('Druck fap999');
    expect(legacyPrintName('fap999', 'fr')).toBe('Odbitka fap999');
  });

  it.each([
    [FRAMED_BLACK, 'pl', '50×70 cm · rama czarna'],
    [FRAMED_NATURAL, 'en', '30×40 cm · frame light brown'],
    [UNFRAMED, 'es', '70×100 cm · sin marco'],
    [FRAMED_MOUNTED, 'de', '50×70 cm · Rahmen dunkelbraun · + Passepartout'],
  ])('formats %j in %s', (variant, locale, expected) => {
    expect(formatLegacyPrintVariant(variant, locale)).toBe(expected);
  });

  it('never renders "undefined" for a corrupt or partial variant', () => {
    expect(formatLegacyPrintVariant({ size: '50x70', framed: true, frameColour: 'teal' }, 'pl')).toBe('50×70 cm · rama');
    expect(formatLegacyPrintVariant({ size: '99x99', framed: false }, 'pl')).toBeNull();
    expect(formatLegacyPrintVariant({ kind: 'giftcard', tierId: 'gc-200' }, 'pl')).toBeNull();
    expect(formatLegacyPrintVariant(null, 'pl')).toBeNull();
    expect(formatLegacyPrintVariant('print', 'pl')).toBeNull();
  });

  it('recognises retired cart tokens', () => {
    expect(isRetiredPrintToken('print:fap005:50x70:true:false:black')).toBe(true);
    expect(isRetiredPrintToken('k01')).toBe(false);
    expect(isRetiredPrintToken('giftcard:gc-200')).toBe(false);
    expect(isRetiredPrintToken(42)).toBe(false);
  });
});
