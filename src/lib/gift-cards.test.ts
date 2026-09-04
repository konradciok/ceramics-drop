import { describe, it, expect } from 'vitest';
import {
  GIFT_CARD_TIERS,
  getGiftCardTier,
  isGiftCardTierId,
  giftCardAmountMajor,
  formatGiftCardAmount,
  isGiftCardToken,
  encodeGiftCardToken,
  decodeGiftCardToken,
  resolveGiftCardToken,
  isGiftCardOrderItemVariant,
  validateGiftCardContact,
  generateGiftCardCode,
  buildGiftCardPromoRow,
} from './gift-cards';

describe('GIFT_CARD_TIERS', () => {
  it('has exactly 4 fixed denominations', () => {
    expect(GIFT_CARD_TIERS).toHaveLength(4);
    expect(GIFT_CARD_TIERS.map((t) => t.id)).toEqual(['gc-200', 'gc-500', 'gc-1000', 'gc-2000']);
  });

  it('matches the settled PLN/EUR/GBP figures', () => {
    expect(GIFT_CARD_TIERS).toEqual([
      { id: 'gc-200', amountPln: 200, amountEur: 50, amountGbp: 40 },
      { id: 'gc-500', amountPln: 500, amountEur: 120, amountGbp: 100 },
      { id: 'gc-1000', amountPln: 1000, amountEur: 250, amountGbp: 200 },
      { id: 'gc-2000', amountPln: 2000, amountEur: 500, amountGbp: 400 },
    ]);
  });
});

describe('getGiftCardTier / isGiftCardTierId', () => {
  it('resolves a known tier', () => {
    expect(getGiftCardTier('gc-500')?.amountPln).toBe(500);
    expect(isGiftCardTierId('gc-500')).toBe(true);
  });

  it('returns null / false for an unknown tier', () => {
    expect(getGiftCardTier('gc-999')).toBeNull();
    expect(isGiftCardTierId('gc-999')).toBe(false);
    expect(getGiftCardTier('')).toBeNull();
  });
});

describe('giftCardAmountMajor / formatGiftCardAmount', () => {
  const tier = getGiftCardTier('gc-500')!;
  it('picks the right currency figure', () => {
    expect(giftCardAmountMajor(tier, 'pln')).toBe(500);
    expect(giftCardAmountMajor(tier, 'eur')).toBe(120);
    expect(giftCardAmountMajor(tier, 'gbp')).toBe(100);
  });
  it('formats a human label', () => {
    expect(formatGiftCardAmount(tier, 'pln')).toBe('500 zł');
    expect(formatGiftCardAmount(tier, 'eur')).toBe('120 €');
    expect(formatGiftCardAmount(tier, 'gbp')).toBe('100 £');
  });
});

describe('gift-card cart token', () => {
  it('round-trips encode/decode', () => {
    const token = encodeGiftCardToken('gc-1000');
    expect(token).toBe('giftcard:gc-1000');
    expect(isGiftCardToken(token)).toBe(true);
    expect(decodeGiftCardToken(token)).toEqual({ tierId: 'gc-1000' });
  });

  it('rejects a non-gift-card id', () => {
    expect(isGiftCardToken('k01')).toBe(false);
    expect(isGiftCardToken('print:fap01:a3:false:false:none')).toBe(false);
    expect(decodeGiftCardToken('k01')).toBeNull();
  });

  it('rejects a malformed or unknown-tier token', () => {
    expect(decodeGiftCardToken('giftcard:')).toBeNull();
    expect(decodeGiftCardToken('giftcard:gc-999')).toBeNull();
    expect(decodeGiftCardToken('giftcard:gc-200:extra')).toBeNull();
    expect(decodeGiftCardToken('giftcard')).toBeNull();
  });
});

describe('resolveGiftCardToken', () => {
  it('resolves to a priced line in minor units', () => {
    const line = resolveGiftCardToken('giftcard:gc-200', 'pln');
    expect(line).toEqual({ tierId: 'gc-200', tier: getGiftCardTier('gc-200'), unitPriceMinor: 20000 });
  });

  it('resolves EUR/GBP correctly', () => {
    expect(resolveGiftCardToken('giftcard:gc-2000', 'eur')?.unitPriceMinor).toBe(50000);
    expect(resolveGiftCardToken('giftcard:gc-2000', 'gbp')?.unitPriceMinor).toBe(40000);
  });

  it('returns null for a malformed token', () => {
    expect(resolveGiftCardToken('giftcard:nope', 'pln')).toBeNull();
    expect(resolveGiftCardToken('k01', 'pln')).toBeNull();
  });
});

describe('isGiftCardOrderItemVariant', () => {
  it('accepts a well-formed gift-card variant', () => {
    expect(isGiftCardOrderItemVariant({ kind: 'giftcard', tierId: 'gc-500' })).toBe(true);
  });
  it('rejects null, print variants, and malformed shapes', () => {
    expect(isGiftCardOrderItemVariant(null)).toBe(false);
    expect(isGiftCardOrderItemVariant({ kind: 'print', size: '30x40' })).toBe(false);
    expect(isGiftCardOrderItemVariant({ kind: 'giftcard', tierId: 'gc-999' })).toBe(false);
    expect(isGiftCardOrderItemVariant({ kind: 'giftcard' })).toBe(false);
  });
});

describe('validateGiftCardContact', () => {
  it('accepts name + email, phone optional', () => {
    const r = validateGiftCardContact({ contact: { first_name: 'Anna', last_name: 'K', email: 'a@example.com' } });
    expect(r).toEqual({ ok: true, contact: { first_name: 'Anna', last_name: 'K', email: 'a@example.com', phone: null } });
  });

  it('carries phone through when present', () => {
    const r = validateGiftCardContact({
      contact: { first_name: 'Anna', last_name: 'K', email: 'a@example.com', phone: '+48123123123' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.contact.phone).toBe('+48123123123');
  });

  it('rejects missing name/email — never requires an address', () => {
    expect(validateGiftCardContact({ contact: {} })).toEqual({ ok: false, reason: 'invalid_contact' });
    expect(validateGiftCardContact({ contact: { first_name: 'Anna' } })).toEqual({ ok: false, reason: 'invalid_contact' });
    expect(validateGiftCardContact(null)).toEqual({ ok: false, reason: 'invalid_contact' });
    expect(validateGiftCardContact({})).toEqual({ ok: false, reason: 'invalid_contact' });
  });
});

describe('generateGiftCardCode', () => {
  it('is deterministic given injected randomness, and matches the promo code format', () => {
    const code = generateGiftCardCode(() => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(code).toMatch(/^GIFT-[A-Z0-9]{8}$/);
    // Same input → same output.
    expect(generateGiftCardCode(() => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toBe(code);
  });

  it('never emits ambiguous characters (0/O/1/I) in the random suffix', () => {
    const bytes = new Uint8Array(8).map((_, i) => i * 7);
    const code = generateGiftCardCode(() => bytes);
    const suffix = code.slice('GIFT-'.length);
    expect(suffix).not.toMatch(/[01OI]/);
  });
});

describe('buildGiftCardPromoRow', () => {
  it('builds a single-use fixed promo row for the tier + order, active immediately', () => {
    const tier = getGiftCardTier('gc-500')!;
    const row = buildGiftCardPromoRow({ tier, orderId: 'order-1', code: 'GIFT-TESTCODE' });
    expect(row).toEqual({
      code: 'GIFT-TESTCODE',
      kind: 'fixed',
      percent: null,
      amount_pln: 50000,
      amount_eur: 12000,
      amount_gbp: 10000,
      applies_to: 'all',
      active: true,
      starts_at: null,
      expires_at: null,
      max_redemptions: 1,
      newsletter_welcome: false,
      campaign: 'gift-card:gc-500',
      source: 'gift_card',
      source_order_id: 'order-1',
      created_by: 'system:gift-card',
      updated_by: 'system:gift-card',
    });
  });

  it('mints a code when none is supplied', () => {
    const tier = getGiftCardTier('gc-200')!;
    const row = buildGiftCardPromoRow({ tier, orderId: 'order-2' });
    expect(row.code).toMatch(/^GIFT-[A-Z0-9]{8}$/);
  });
});
