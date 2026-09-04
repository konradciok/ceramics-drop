import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { validateCart, MAX_CART } from './checkout';
import { encodePrintToken } from './print-cart';
import { encodeGiftCardToken } from './gift-cards';
import type { Product } from './types';

// Mock the DB catalog loader so we can exercise the CATALOG_SOURCE=db path
// (getProductById → loadCeramicCatalog → dynamic import of ./catalog/load).
vi.mock('./catalog/load', () => ({
  loadCeramicProductsFromDb: vi.fn(),
  loadPrintDesignsFromDb: vi.fn(),
}));
vi.mock('@/server/print-assets/repository', () => ({
  resolvePrintAsset: vi.fn(),
}));
// Mock the pricing-config loader so the db-mode test can prove checkout prices
// from the DB config (admin-edited), not the code default.
vi.mock('./print-pricing-config/load', () => ({
  loadPrintPricingConfigFromDb: vi.fn(),
}));
import { loadCeramicProductsFromDb } from './catalog/load';
import { resolvePrintAsset } from '@/server/print-assets/repository';
import { loadPrintPricingConfigFromDb } from './print-pricing-config/load';
import { DEFAULT_PRINT_PRICING } from './print-pricing';

const MOCK_ASSET = {
  assetId: 'asset-uuid-1',
  r2Key: 'prints/fap005/rev1/3600x4800-abc.jpg',
  sha256: 'a'.repeat(64),
  contentType: 'image/jpeg' as const,
  widthPx: 4800,
  heightPx: 7200,
};

const k01 = (status?: Product['status']): Product => ({
  id: 'k01',
  category: 'kubki',
  num: '01',
  image: '/uploads/kubek-1.webp',
  price: 95,
  measure: '8 × 8 × 10 cm',
  sold: false,
  dropId: 'drop-1',
  noteIndex: 0,
  ...(status ? { status } : {}),
});

describe('validateCart', () => {
  beforeEach(() => {
    vi.mocked(resolvePrintAsset).mockResolvedValue(MOCK_ASSET);
  });

  it('maps known ids to products with grosze prices', async () => {
    const r = await validateCart(['k01', 'v01']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items.map((i) => i.product_id)).toEqual(['k01', 'v01']);
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
    const r = await validateCart(['k01', 'k01']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toHaveLength(1);
  });

  it('rejects carts above MAX_CART', async () => {
    const many = Array.from({ length: MAX_CART + 1 }, (_, i) => `x${i}`);
    expect((await validateCart(many)).ok).toBe(false);
  });

  it('resolves items to euro-cents when currency is eur', async () => {
    // k01 is kubki → PRICE_EUR.kubki = 25 → toMinor(25) = 2500
    const result = await validateCart(['k01'], 'eur');
    expect(result).toEqual({ ok: true, items: [{ product_id: 'k01', unit_price: 2500 }] });
  });

  it('default currency (no arg) still produces grosze', async () => {
    // k01 is kubki → product.price = PRICE_PLN.kubki = 95 → toMinor(95) = 9500
    const result = await validateCart(['k01']);
    expect(result).toEqual({ ok: true, items: [{ product_id: 'k01', unit_price: 9500 }] });
  });

  it('resolves items to pence when currency is gbp', async () => {
    // k01 is kubki → PRICE_GBP.kubki = 22 → toMinor(22) = 2200
    const result = await validateCart(['k01'], 'gbp');
    expect(result).toEqual({ ok: true, items: [{ product_id: 'k01', unit_price: 2200 }] });
  });

  it('accepts a valid print token and snapshots the resolved asset', async () => {
    const token = encodePrintToken('fap005', { size: '50x70', framed: true, mount: false, frameColour: 'black' });
    const result = await validateCart([token], 'pln');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].variant?.prodigiSku).toBe('GLOBAL-CFP-20X28');
    expect(result.items[0].unit_price).toBe(36500); // (215 base + 150 frame) PLN × 100 (DEFAULT_PRINT_PRICING)
    expect(result.items[0].variant).toMatchObject({
      assetId: MOCK_ASSET.assetId,
      assetKey: MOCK_ASSET.r2Key,
      assetSha256: MOCK_ASSET.sha256,
      assetContentType: MOCK_ASSET.contentType,
      assetWidthPx: MOCK_ASSET.widthPx,
      assetHeightPx: MOCK_ASSET.heightPx,
    });
    expect(resolvePrintAsset).toHaveBeenCalledWith('fap005', '50x70:true:false:black');
  });

  it('prices prints from the DB pricing config in db mode, not the code default', async () => {
    vi.stubEnv('CATALOG_SOURCE', 'db');
    // The catalog loaders are bare vi.fn()s here, so the design read falls back
    // to the registry with a logged error — silence it; the pricing read is the
    // subject under test.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.mocked(loadPrintPricingConfigFromDb).mockResolvedValue({
        ...DEFAULT_PRINT_PRICING,
        baseEur: { ...DEFAULT_PRINT_PRICING.baseEur, '50x70': 99 }, // admin-edited value
      });
      const token = encodePrintToken('fap005', { size: '50x70', framed: false, mount: false, frameColour: 'none' });
      const result = await validateCart([token], 'eur');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.items[0].unit_price).toBe(9900); // 99 EUR × 100 from the DB config
      expect(loadPrintPricingConfigFromDb).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      errSpy.mockRestore();
    }
  });

  it('rejects a print variant with no ready asset', async () => {
    vi.mocked(resolvePrintAsset).mockResolvedValueOnce(null);
    const token = encodePrintToken('fap005', { size: '50x70', framed: true, mount: false, frameColour: 'black' });
    expect(await validateCart([token], 'pln')).toEqual({ ok: false, reason: 'print_asset_unavailable' });
  });

  it('returns print_asset_error on a transient DB error from resolvePrintAsset', async () => {
    vi.mocked(resolvePrintAsset).mockRejectedValueOnce(new Error('connection reset'));
    const token = encodePrintToken('fap005', { size: '50x70', framed: true, mount: false, frameColour: 'black' });
    expect(await validateCart([token], 'pln')).toEqual({ ok: false, reason: 'print_asset_error' });
  });

  it('rejects a mixed ceramics + prints cart', async () => {
    const token = encodePrintToken('fap005', { size: '50x70', framed: true, mount: false, frameColour: 'black' });
    expect(await validateCart(['k01', token], 'pln')).toEqual({ ok: false, reason: 'mixed_cart' });
  });

  it('rejects an unknown design id in print token', async () => {
    const token = encodePrintToken('fap99', { size: '30x40', framed: false, mount: false, frameColour: 'none' });
    expect(await validateCart([token], 'pln')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects an unpublished design', async () => {
    const token = encodePrintToken('fap04', { size: '30x40', framed: false, mount: false, frameColour: 'none' });
    expect(await validateCart([token], 'pln')).toEqual({ ok: false, reason: 'unknown' });
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
    expect(await validateCart(['k01', encodeGiftCardToken('gc-200')], 'pln')).toEqual({
      ok: false,
      reason: 'mixed_cart',
    });
  });

  it('rejects a cart mixing a gift card with a print', async () => {
    const token = encodePrintToken('fap005', { size: '50x70', framed: true, mount: false, frameColour: 'black' });
    expect(await validateCart([token, encodeGiftCardToken('gc-200')], 'pln')).toEqual({
      ok: false,
      reason: 'mixed_cart',
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
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue([k01('hidden')]);
    expect(await validateCart(['k01'], 'pln')).toEqual({ ok: false, reason: 'not_for_sale' });
  });

  it('accepts the same ceramic once active', async () => {
    process.env.CATALOG_SOURCE = 'db';
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue([k01()]);
    const r = await validateCart(['k01'], 'pln');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0]).toEqual({ product_id: 'k01', unit_price: 9500 });
  });
});
