import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINT_PRICING } from '../print-pricing';
import { printPricingConfigSchema } from './schema';

describe('printPricingConfigSchema', () => {
  it('round-trips the code default', () => {
    expect(printPricingConfigSchema.parse(DEFAULT_PRINT_PRICING)).toEqual(DEFAULT_PRINT_PRICING);
  });

  it('rejects a negative price', () => {
    const bad = structuredClone(DEFAULT_PRINT_PRICING);
    bad.frameEur['50x70'] = -1;
    expect(printPricingConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a fractional price (whole EUR only)', () => {
    const bad = structuredClone(DEFAULT_PRINT_PRICING);
    bad.baseEur['30x40'] = 24.5;
    expect(printPricingConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a zero base but accepts a zero surcharge (free-frame promo)', () => {
    const zeroBase = structuredClone(DEFAULT_PRINT_PRICING);
    zeroBase.baseEur['70x100'] = 0;
    expect(printPricingConfigSchema.safeParse(zeroBase).success).toBe(false);

    const freeFrame = structuredClone(DEFAULT_PRINT_PRICING);
    freeFrame.frameEur['30x40'] = 0;
    freeFrame.mountEur['30x40'] = 0;
    expect(printPricingConfigSchema.safeParse(freeFrame).success).toBe(true);
  });

  it('rejects a zero or negative rate', () => {
    for (const value of [0, -4.25]) {
      const bad = structuredClone(DEFAULT_PRINT_PRICING);
      bad.eurToPln = value;
      expect(printPricingConfigSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects a rate with more than 4 decimal places', () => {
    const bad = structuredClone(DEFAULT_PRINT_PRICING);
    bad.eurToGbp = 0.86001;
    expect(printPricingConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown keys (strict) so a client cannot smuggle extra fields', () => {
    const bad = { ...structuredClone(DEFAULT_PRINT_PRICING), extra: 1 };
    expect(printPricingConfigSchema.safeParse(bad).success).toBe(false);

    const badNested = structuredClone(DEFAULT_PRINT_PRICING) as unknown as Record<string, unknown>;
    badNested.baseEur = { ...(badNested.baseEur as object), '100x140': 99 };
    expect(printPricingConfigSchema.safeParse(badNested).success).toBe(false);
  });
});
