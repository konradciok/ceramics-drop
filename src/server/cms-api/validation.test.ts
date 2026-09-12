import { describe, expect, it } from 'vitest';
import { validateProductDraft } from './validation';

const validCeramic = {
  type: 'ceramic',
  category: 'kubki',
  displayNumber: '12',
  measure: '9x8',
  pricePln: 12000,
  priceEur: 2800,
  priceGbp: 2400,
  images: ['https://x.test/a.webp'],
  title: { pl: 'Kubek' },
  description: { pl: 'Opis' },
  showroom: false,
};

const validPrint = {
  type: 'print',
  displayNumber: '42',
  sizes: ['30x40'],
  mountAvailable: true,
  images: ['https://x.test/a.webp'],
  title: { pl: 'Cisza' },
  description: { pl: 'Opis' },
};

describe('validateProductDraft', () => {
  it('accepts a minimal valid ceramic draft', () => {
    expect(validateProductDraft(validCeramic)).toEqual({ ok: true, data: validCeramic });
  });

  it('accepts a minimal valid print draft', () => {
    const result = validateProductDraft(validPrint);
    expect(result.ok).toBe(true);
  });

  it('rejects a ceramic draft missing images', () => {
    const result = validateProductDraft({ ...validCeramic, images: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.images).toBeDefined();
  });

  it('rejects a ceramic draft with a zero price (matches the DB products_ceramic_price_positive check)', () => {
    const result = validateProductDraft({ ...validCeramic, pricePln: 0 });
    expect(result.ok).toBe(false);
  });

  it('rejects a draft missing the pl title', () => {
    const result = validateProductDraft({ ...validCeramic, title: { en: 'Mug' } });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown category', () => {
    const result = validateProductDraft({ ...validCeramic, category: 'nope' });
    expect(result.ok).toBe(false);
  });

  it('rejects a print draft with an unknown size', () => {
    const result = validateProductDraft({ ...validPrint, sizes: ['99x99'] });
    expect(result.ok).toBe(false);
  });

  it('rejects extra properties not in the schema (strict)', () => {
    const result = validateProductDraft({ ...validCeramic, mysteryField: true });
    expect(result.ok).toBe(false);
  });

  it('rejects a body with no discriminating type', () => {
    const result = validateProductDraft({ foo: 'bar' });
    expect(result.ok).toBe(false);
  });
});
