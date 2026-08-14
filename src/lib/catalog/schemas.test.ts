import { describe, it, expect } from 'vitest';
import { productStatusSchema, productUpdateSchema } from './schemas';

describe('productUpdateSchema', () => {
  it('accepts a valid partial patch', () => {
    expect(productUpdateSchema.safeParse({ price_pln: 120, measure: '9 cm', seo_title: 'Lazur' }).success).toBe(true);
    expect(productUpdateSchema.safeParse({}).success).toBe(true); // no-op patch is valid
  });

  it('rejects unknown keys (strict) — e.g. per-product EUR overrides are not editable', () => {
    expect(productUpdateSchema.safeParse({ price_eur: 25 }).success).toBe(false);
    expect(productUpdateSchema.safeParse({ category_slug: 'wazony' }).success).toBe(false);
  });

  it('blank seo/slug fields clear to null; absent fields stay untouched', () => {
    const cleared = productUpdateSchema.parse({ seo_title: '  ', slug: '' });
    expect(cleared.seo_title).toBeNull();
    expect(cleared.slug).toBeNull();
    const untouched = productUpdateSchema.parse({ price_pln: 100 });
    expect('slug' in untouched).toBe(false);
  });

  it('validates slug as lowercase kebab-case', () => {
    expect(productUpdateSchema.safeParse({ slug: 'kubek-lazur-1' }).success).toBe(true);
    expect(productUpdateSchema.safeParse({ slug: 'Kubek Lazur' }).success).toBe(false);
    expect(productUpdateSchema.safeParse({ slug: 'kubek--lazur' }).success).toBe(false);
  });

  it('rejects a negative or non-integer price', () => {
    expect(productUpdateSchema.safeParse({ price_pln: -5 }).success).toBe(false);
    expect(productUpdateSchema.safeParse({ price_pln: 9.5 }).success).toBe(false);
  });

  it('rejects a 0 price — 0 was never a legitimate ceramic price (M-4)', () => {
    expect(productUpdateSchema.safeParse({ price_pln: 0 }).success).toBe(false);
  });
});

describe('productStatusSchema', () => {
  it('accepts the four publish statuses', () => {
    for (const status of ['draft', 'active', 'hidden', 'archived'] as const) {
      expect(productStatusSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it('rejects a runtime-only or unknown status', () => {
    expect(productStatusSchema.safeParse({ status: 'sold' }).success).toBe(false);
    expect(productStatusSchema.safeParse({}).success).toBe(false);
  });
});
