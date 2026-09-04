import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromoCode } from '@/lib/promo';

const validateCart = vi.fn(() => ({
  ok: true as const,
  items: [{ product_id: 'k01', unit_price: 9_000 }],
}));
const getClientIp = vi.fn(() => '203.0.113.60');
const fetchPromoByCode = vi.fn<
  (supabase: unknown, code: string) => Promise<{ promo: PromoCode | null; redemptionCount: number }>
>(async () => ({ promo: null, redemptionCount: 0 }));

vi.mock('@/lib/checkout', () => ({ validateCart }));
vi.mock('@/lib/client-ip', () => ({ getClientIp }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/promo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/promo')>();
  return { ...actual, fetchPromoByCode };
});

const PROMO_ID = '11111111-2222-4333-8444-555555555555';
function mkPromo(overrides: Partial<PromoCode> = {}): PromoCode {
  return {
    id: PROMO_ID,
    code: 'WELCOME10',
    kind: 'percent',
    percent: 10,
    amount_pln: null,
    amount_eur: null,
    amount_gbp: null,
    applies_to: 'all',
    active: true,
    starts_at: null,
    expires_at: null,
    max_redemptions: null,
    newsletter_welcome: false,
    campaign: null,
    source: 'admin',
    source_order_id: null,
    ...overrides,
  };
}

const PRINT_ITEM = {
  product_id: 'print:fap01:50x70:true:false:black',
  unit_price: 42_000,
  variant: { size: '50x70', framed: true, mount: false, frameColour: 'black' },
};

const post = async (body: Record<string, unknown>, init: RequestInit = {}) => {
  const { POST } = await import('./route');
  return POST(
    new Request('http://localhost/api/promo/validate', {
      method: 'POST',
      body: JSON.stringify(body),
      ...init,
    }),
  );
};

describe('POST /api/promo/validate', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('previews a percent code on a ceramic PLN cart', async () => {
    fetchPromoByCode.mockResolvedValueOnce({ promo: mkPromo(), redemptionCount: 0 });
    const res = await post({ code: '  welcome10 ', ids: ['k01'], locale: 'pl' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, code: 'WELCOME10', discount: 900 });
    expect(fetchPromoByCode).toHaveBeenCalledWith(expect.anything(), 'WELCOME10');
    expect(validateCart).toHaveBeenCalledWith(['k01'], 'pln');
  });

  it('previews a fixed EUR code on a print cart (currency from cookie)', async () => {
    validateCart.mockReturnValueOnce({
      ok: true,
      items: [PRINT_ITEM],
    } as unknown as ReturnType<typeof validateCart>);
    fetchPromoByCode.mockResolvedValueOnce({
      promo: mkPromo({
        code: 'ART10',
        kind: 'fixed',
        percent: null,
        amount_pln: 4_500,
        amount_eur: 1_000,
        amount_gbp: 900,
        applies_to: 'prints',
      }),
      redemptionCount: 0,
    });
    const res = await post(
      { code: 'art10', ids: [PRINT_ITEM.product_id], locale: 'en' },
      { headers: { Cookie: 'currency_pref=eur' } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, code: 'ART10', discount: 1_000 });
    expect(validateCart).toHaveBeenCalledWith([PRINT_ITEM.product_id], 'eur');
  });

  it('soft-fails with wrong_track for a ceramics-only code on a print cart (200, ok:false)', async () => {
    validateCart.mockReturnValueOnce({
      ok: true,
      items: [PRINT_ITEM],
    } as unknown as ReturnType<typeof validateCart>);
    fetchPromoByCode.mockResolvedValueOnce({
      promo: mkPromo({ applies_to: 'ceramics' }),
      redemptionCount: 0,
    });
    const res = await post({ code: 'WELCOME10', ids: [PRINT_ITEM.product_id], locale: 'en' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'wrong_track' });
  });

  it.each([
    ['expired', { expires_at: '2020-01-01T00:00:00Z' }],
    ['inactive', { active: false }],
  ] as const)('soft-fails with %s', async (reason, overrides) => {
    fetchPromoByCode.mockResolvedValueOnce({ promo: mkPromo(overrides), redemptionCount: 0 });
    const res = await post({ code: 'WELCOME10', ids: ['k01'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason });
  });

  it('soft-fails with not_found for an unknown code', async () => {
    fetchPromoByCode.mockResolvedValueOnce({ promo: null, redemptionCount: 0 });
    const res = await post({ code: 'NOPE99', ids: ['k01'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'not_found' });
  });

  it('400s on a malformed code without hitting the DB', async () => {
    const res = await post({ code: 'zażółć', ids: ['k01'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(fetchPromoByCode).not.toHaveBeenCalled();
  });

  it('400s on a non-object JSON body (`null`) instead of 500ing on a null dereference', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/promo/validate', { method: 'POST', body: 'null' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('400s on empty or missing ids', async () => {
    expect((await post({ code: 'WELCOME10', ids: [] })).status).toBe(400);
    expect((await post({ code: 'WELCOME10' })).status).toBe(400);
    expect((await post({ code: 'WELCOME10', ids: [42] })).status).toBe(400);
  });

  it('400s when the cart itself does not validate', async () => {
    validateCart.mockReturnValueOnce(
      { ok: false, reason: 'mixed_cart' } as unknown as ReturnType<typeof validateCart>,
    );
    const res = await post({ code: 'WELCOME10', ids: ['k01', 'print:x'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('rate-limits promo enumeration (429 after the per-IP budget)', async () => {
    fetchPromoByCode.mockResolvedValue({ promo: null, redemptionCount: 0 });
    let last: Response | null = null;
    for (let i = 0; i < 31; i += 1) {
      last = await post({ code: 'WELCOME10', ids: ['k01'] });
    }
    expect(last?.status).toBe(429);
    expect(await last?.json()).toEqual({ error: 'rate_limited' });
    expect(Number(last?.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});
