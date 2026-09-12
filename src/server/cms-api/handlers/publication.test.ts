import { describe, expect, it, vi, beforeEach } from 'vitest';
import { publicationGetRoute, publicationPostRoute } from './publication';
import type { HandlerContext } from '../router';
import * as mapping from '../mapping';
import * as readiness from '../readiness';
import * as idempotency from '../idempotency';

vi.mock('../mapping');
vi.mock('../readiness');
vi.mock('../idempotency');

const ceramicProduct = {
  id: 'prd_1',
  revision: 3,
  type: 'ceramic',
  draft: { type: 'ceramic', category: 'kubki', displayNumber: '01', measure: '9x8', pricePln: 12000, priceEur: 2800, priceGbp: 2400, images: ['a.webp'], seo: { pl: 'meta' } },
} as never;

const printProduct = {
  id: 'prd_2',
  revision: 5,
  type: 'print',
  draft: { type: 'print', sizes: ['30x40'], mountAvailable: false, images: ['b.webp'] },
} as never;

function req(body: unknown, idempotencyKey: string | null = 'key-1') {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request('https://x.test/v1/products/prd_1/publication', { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

describe('publicationGetRoute', () => {
  it('returns 404 when the product does not exist', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(null);
    const res = await publicationGetRoute.handler(new Request('https://x.test/v1/products/nope/publication'), {} as CloudflareEnv, { id: 'nope' }, ctxWith(vi.fn()));
    expect(res.status).toBe(404);
  });

  it('returns the computed readiness for an existing product', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(ceramicProduct);
    vi.mocked(readiness.computeReadiness).mockResolvedValue({ revision: 3, ready: true, blockers: [], warnings: [] });
    const res = await publicationGetRoute.handler(new Request('https://x.test/v1/products/prd_1/publication'), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(vi.fn()));
    expect(await res.json()).toEqual({ revision: 3, ready: true, blockers: [], warnings: [] });
  });
});

describe('publicationPostRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(readiness.buildPrintVariantSpecs).mockReturnValue([{ variant_key: '30x40:false:false:none', sku: 'X', print_area_width_px: 1, print_area_height_px: 2 }]);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'publish' }, null), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
  });

  it('rejects an invalid action', async () => {
    const res = await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'delete' }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
  });

  it('blocks publish and releases the lease when readiness is not ready', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(printProduct);
    vi.mocked(readiness.computeReadiness).mockResolvedValue({ revision: 5, ready: false, blockers: ['Zaakceptuj proof dla wariantu X.'], warnings: [] });
    const rpc = vi.fn();
    const res = await publicationPostRoute.handler(req({ expectedRevision: 5, action: 'publish' }), {} as CloudflareEnv, { id: 'prd_2' }, ctxWith(rpc));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('PRINT_ASSETS_INCOMPLETE');
    expect(rpc).not.toHaveBeenCalled();
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('publishes a ceramic with structural params and no variants param', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(ceramicProduct);
    vi.mocked(readiness.computeReadiness).mockResolvedValue({ revision: 3, ready: true, blockers: [], warnings: [] });
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'publish' }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc));
    expect(res.status).toBe(200);
    const [, params] = rpc.mock.calls[0];
    expect(params.p_variants).toBeNull();
    expect(params.p_structural).toMatchObject({ category_slug: 'kubki', price_pln: 120, price_eur: 28, price_gbp: 24 });
    expect(params.p_media).toEqual([{ url: 'a.webp', alt: null, position: 0, is_primary: true }]);
  });

  it('publishes a print with variant params and no structural param', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(printProduct);
    vi.mocked(readiness.computeReadiness).mockResolvedValue({ revision: 5, ready: true, blockers: [], warnings: [] });
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await publicationPostRoute.handler(req({ expectedRevision: 5, action: 'publish' }), {} as CloudflareEnv, { id: 'prd_2' }, ctxWith(rpc));
    const [, params] = rpc.mock.calls[0];
    expect(params.p_structural).toBeNull();
    expect(params.p_variants).toEqual([{ variant_key: '30x40:false:false:none', sku: 'X', print_area_width_px: 1, print_area_height_px: 2 }]);
  });

  it('hides without computing readiness or passing variants/media/structural', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(ceramicProduct);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'hide' }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc));
    expect(readiness.computeReadiness).not.toHaveBeenCalled();
    const [, params] = rpc.mock.calls[0];
    expect(params).toMatchObject({ p_action: 'hide', p_variants: null, p_media: null, p_structural: null });
  });

  it('maps a revision_conflict RPC error to 409', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(ceramicProduct);
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=9' } });
    const res = await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'hide' }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc));
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(9);
  });
});
