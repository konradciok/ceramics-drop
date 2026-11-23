import { afterEach, describe, it, expect, vi } from 'vitest';
import { validateCart, MAX_CART } from './checkout';
import { encodeGiftCardToken } from './gift-cards';
import type { Product } from './types';

// Mock the DB catalog loader so we can exercise the CATALOG_SOURCE=db path
// (getProductById → loadCeramicCatalog → dynamic import of ./catalog/load).
vi.mock('./catalog/load', () => ({
  loadCeramicProductsFromDb: vi.fn(),
}));
import { loadCeramicProductsFromDb } from './catalog/load';

// A token from the retired print shop, exactly as old carts persisted it.
const PRINT_TOKEN = 'print:fap005:50x70:true:false:black';

const k28 = (status?: Product['status']): Product => ({
  id: 'k28',
  category: 'kubki',
  num: '01',
  image: '/uploads/kubek-drop2-1.webp',
  price: 95,
  measure: '8 × 8 × 10 cm',
  sold: false,
  dropId: 'drop-2',
  noteIndex: 0,
  ...(status ? { status } : {}),
});

describe('validateCart', () => {
  it('maps known ids to products with grosze prices', async () => {
    const r = await validateCart(['k28', 'v10']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items.map((i) => i.product_id)).toEqual(['k28', 'v10']);
      expect(r.items[0].unit_price).toBe(9500);   // kubki 95 zł
      expect(r.items[1].unit_price).toBe(23900);  // wazony 239 zł
    }
  });

  it('rejects an empty cart', async () => {
    expect((await validateCart([])).ok).toBe(false);
  });

  it('rejects unknown ids', async () => {
    expect((await validateCart(['nope'])).ok).toBe(false);
  });

  it('dedupes repeated ids (1/1 — one each)', async () => {
    const r = await validateCart(['k28', 'k28']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toHaveLength(1);
  });

  it('rejects carts above MAX_CART', async () => {
    const many = Array.from({ length: MAX_CART + 1 }, (_, i) => `x${i}`);
    expect((await validateCart(many)).ok).toBe(false);
  });

  it('resolves items to euro-cents when currency is eur', async () => {
    // k28 is kubki → PRICE_EUR.kubki = 25 → toMinor(25) = 2500
    const result = await validateCart(['k28'], 'eur');
    expect(result).toEqual({ ok: true, items: [{ product_id: 'k28', unit_price: 2500 }] });
  });

  it('default currency (no arg) still produces grosze', async () => {
    // k28 is kubki → product.price = PRICE_PLN.kubki = 95 → toMinor(95) = 9500
    const result = await validateCart(['k28']);
    expect(result).toEqual({ ok: true, items: [{ product_id: 'k28', unit_price: 9500 }] });
  });

  it('resolves items to pence when currency is gbp', async () => {
    // k28 is kubki → PRICE_GBP.kubki = 22 → toMinor(22) = 2200
    const result = await validateCart(['k28'], 'gbp');
    expect(result).toEqual({ ok: true, items: [{ product_id: 'k28', unit_price: 2200 }] });
  });

  it('prices EUR/GBP from the product DB-backed priceEur/priceGbp in db mode, not the code constant (S2b)', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'db');
    try {
      vi.mocked(loadCeramicProductsFromDb).mockResolvedValue([{ ...k28(), priceEur: 30, priceGbp: 26 }]);
      const eur = await validateCart(['k28'], 'eur');
      expect(eur).toEqual({ ok: true, items: [{ product_id: 'k28', unit_price: 3000 }] });
      const gbp = await validateCart(['k28'], 'gbp');
      expect(gbp).toEqual({ ok: true, items: [{ product_id: 'k28', unit_price: 2600 }] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses any print token as not_for_sale (prints moved to their own shop)', async () => {
    expect(await validateCart([PRINT_TOKEN])).toEqual({ ok: false, reason: 'not_for_sale' });
    // Also when mixed into an otherwise valid ceramic cart — never silently dropped.
    expect(await validateCart(['k28', PRINT_TOKEN])).toEqual({ ok: false, reason: 'not_for_sale' });
  });
});

describe('validateCart gift cards', () => {
  it('resolves a gift-card token to a priced item in the checkout currency', async () => {
    const result = await validateCart([encodeGiftCardToken('gc-500')], 'pln');
    expect(result).toEqual({
      ok: true,
      items: [{ product_id: 'gc-500', unit_price: 50000, giftCardTierId: 'gc-500' }],
    });
  });

  it('resolves EUR/GBP figures', async () => {
    const eur = await validateCart([encodeGiftCardToken('gc-200')], 'eur');
    expect(eur.ok).toBe(true);
    if (eur.ok) expect(eur.items[0].unit_price).toBe(5000);
    const gbp = await validateCart([encodeGiftCardToken('gc-200')], 'gbp');
    expect(gbp.ok).toBe(true);
    if (gbp.ok) expect(gbp.items[0].unit_price).toBe(4000);
  });

  it('rejects an unknown tier token', async () => {
    expect(await validateCart(['giftcard:gc-999'], 'pln')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects a cart mixing a gift card with a ceramic', async () => {
    expect(await validateCart(['k28', encodeGiftCardToken('gc-200')], 'pln')).toEqual({
      ok: false,
      reason: 'mixed_cart',
    });
  });

  it('refuses a gift card alongside a print token (the print is no longer for sale)', async () => {
    expect(await validateCart([PRINT_TOKEN, encodeGiftCardToken('gc-200')], 'pln')).toEqual({
      ok: false,
      reason: 'not_for_sale',
    });
  });

  it('rejects more than one gift-card tier in a single cart', async () => {
    expect(
      await validateCart([encodeGiftCardToken('gc-200'), encodeGiftCardToken('gc-500')], 'pln'),
    ).toEqual({ ok: false, reason: 'multiple_gift_cards' });
  });

  it('is idempotent for the same tier token repeated (Set dedup)', async () => {
    const result = await validateCart([encodeGiftCardToken('gc-1000'), encodeGiftCardToken('gc-1000')], 'pln');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toHaveLength(1);
  });
});

describe('validateCart status gating (CATALOG_SOURCE=db)', () => {
  const original = process.env.CATALOG_SOURCE;
  afterEach(() => {
    if (original === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = original;
    vi.clearAllMocks();
  });

  it('hard-blocks a non-active ceramic with not_for_sale (before any reservation)', async () => {
    process.env.CATALOG_SOURCE = 'db';
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue([k28('hidden')]);
    expect(await validateCart(['k28'], 'pln')).toEqual({ ok: false, reason: 'not_for_sale' });
  });

  it('accepts the same ceramic once active', async () => {
    process.env.CATALOG_SOURCE = 'db';
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue([k28()]);
    const r = await validateCart(['k28'], 'pln');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0]).toEqual({ product_id: 'k28', unit_price: 9500 });
  });
});
