import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { PATCH } from './[id]/route';

const mocks = vi.hoisted(() => ({
  adminSupabase: vi.fn(() => ({})),
  listPromotions: vi.fn(),
  createPromotion: vi.fn(),
  updatePromotion: vi.fn(),
}));
vi.mock('@/lib/admin/clients', () => ({ adminSupabase: mocks.adminSupabase }));
vi.mock('@/lib/admin/promotions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/promotions')>();
  return {
    ...actual,
    listPromotions: mocks.listPromotions,
    createPromotion: mocks.createPromotion,
    updatePromotion: mocks.updatePromotion,
  };
});

const VALID_BODY = {
  code: 'WELCOME10',
  kind: 'percent',
  percent: 10,
  amount_pln: null,
  amount_eur: null,
  amount_gbp: null,
  applies_to: 'all',
  starts_at: null,
  expires_at: null,
  max_redemptions: null,
  newsletter_welcome: false,
  campaign: null,
};

const PROMO_ID = '11111111-2222-4333-8444-555555555555';

function req(url: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('/api/admin/promotions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET returns the repository listing', async () => {
    mocks.listPromotions.mockResolvedValue([{ code: 'WELCOME10' }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ promotions: [{ code: 'WELCOME10' }] });
  });

  it('GET maps a repository throw to 500 without leaking detail', async () => {
    mocks.listPromotions.mockRejectedValue(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET();
    errSpy.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'promo_read_failed' });
  });

  it('POST rejects a cross-field violation with 400 + fields before touching the repository', async () => {
    const res = await POST(
      req('http://localhost/api/admin/promotions', 'POST', { ...VALID_BODY, percent: null }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('validation_failed');
    expect(json.fields).toBeDefined();
    expect(mocks.createPromotion).not.toHaveBeenCalled();
  });

  it('POST passes parsed input + actor email through and returns the repository status', async () => {
    mocks.createPromotion.mockResolvedValue({ status: 201, body: { promotion: { code: 'WELCOME10' } } });
    const res = await POST(
      req('http://localhost/api/admin/promotions', 'POST', VALID_BODY, {
        'X-Admin-Actor-Email': 'anna@studio.pl',
      }),
    );
    expect(res.status).toBe(201);
    expect(mocks.createPromotion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: 'WELCOME10' }),
      'anna@studio.pl',
    );
  });

  it('PATCH 404s a non-uuid id without parsing', async () => {
    const res = await PATCH(req('http://localhost/api/admin/promotions/x', 'PATCH', { active: true }), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(404);
    expect(mocks.updatePromotion).not.toHaveBeenCalled();
  });

  it('PATCH forwards a bare active toggle and returns the repository status', async () => {
    mocks.updatePromotion.mockResolvedValue({ status: 200, body: { promotion: { active: true } } });
    const res = await PATCH(
      req(`http://localhost/api/admin/promotions/${PROMO_ID}`, 'PATCH', { active: true }),
      { params: Promise.resolve({ id: PROMO_ID }) },
    );
    expect(res.status).toBe(200);
    expect(mocks.updatePromotion).toHaveBeenCalledWith(expect.anything(), PROMO_ID, { active: true }, null);
  });

  it('PATCH keeps `code` in the parsed patch so the repository can 400 code_immutable', async () => {
    mocks.updatePromotion.mockResolvedValue({ status: 400, body: { error: 'code_immutable' } });
    const res = await PATCH(
      req(`http://localhost/api/admin/promotions/${PROMO_ID}`, 'PATCH', { code: 'NEWCODE' }),
      { params: Promise.resolve({ id: PROMO_ID }) },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'code_immutable' });
    expect(mocks.updatePromotion).toHaveBeenCalledWith(
      expect.anything(),
      PROMO_ID,
      expect.objectContaining({ code: 'NEWCODE' }),
      null,
    );
  });
});
