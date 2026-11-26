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
  draft: {
    type: 'ceramic',
    category: 'kubki',
    displayNumber: '01',
    measure: '9x8',
    pricePln: 12000,
    priceEur: 2800,
    priceGbp: 2400,
    images: ['a.webp'],
    title: { pl: 'Kubek Lazur' },
    description: { pl: 'Ręcznie toczony kubek.' },
    seo: { pl: 'meta' },
  },
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
  });

  it('requires an Idempotency-Key', async () => {
    const res = await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'publish' }, null), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
  });

  it('rejects an invalid action', async () => {
    const res = await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'delete' }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
  });

  it('rejects a literal null request body with 422 instead of throwing', async () => {
    const res = await publicationPostRoute.handler(req(null), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('blocks publishing a (retired) print and releases the lease when readiness is not ready', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(printProduct);
    vi.mocked(readiness.computeReadiness).mockResolvedValue({ revision: 5, ready: false, blockers: ['Druki są wycofane.'], warnings: [] });
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
    expect(params.p_structural).toMatchObject({
      category_slug: 'kubki',
      price_pln: 120,
      price_eur: 28,
      price_gbp: 24,
      title: 'Kubek Lazur',
      description: 'Ręcznie toczony kubek.',
    });
    expect(params.p_media).toEqual([{ url: 'a.webp', alt: null, position: 0, is_primary: true }]);
  });

  it.each([
    ['major units typed into minor-unit fields (CO-03 PoC)', { pricePln: 95, priceEur: 49, priceGbp: 149 }],
    ['a synthesized draft whose price_eur was NULL (→ priceEur 0)', { pricePln: 12000, priceEur: 0, priceGbp: 2400 }],
    ['a price that is not a whole major unit', { pricePln: 12000, priceEur: 2850, priceGbp: 2400 }],
  ])('refuses to publish a ceramic with %s and releases the lease', async (_label, prices) => {
    const badPriceProduct = {
      ...(ceramicProduct as unknown as Record<string, unknown>),
      draft: { ...(ceramicProduct as unknown as { draft: Record<string, unknown> }).draft, ...prices },
    } as never;
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(badPriceProduct);
    vi.mocked(readiness.computeReadiness).mockResolvedValue({ revision: 3, ready: true, blockers: [], warnings: [] });
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'publish' }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(body.fieldErrors).length).toBeGreaterThan(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('normalizes a blank dropId (empty string, not undefined) to null rather than forwarding it', async () => {
    // cms-ceramics's dropId field is a controlled text input: left blank, it
    // submits '' — the RPC's coalesce would otherwise treat '' as a real
    // override and violate the drop_id FK instead of defaulting server-side.
    const blankDropIdProduct = {
      id: 'prd_1',
      revision: 3,
      type: 'ceramic',
      draft: {
        type: 'ceramic',
        category: 'kubki',
        displayNumber: '01',
        measure: '9x8',
        pricePln: 12000,
        priceEur: 2800,
        priceGbp: 2400,
        images: ['a.webp'],
        title: { pl: 'Kubek Lazur' },
        description: { pl: 'Ręcznie toczony kubek.' },
        seo: { pl: 'meta' },
        dropId: '  ',
      },
    } as never;
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(blankDropIdProduct);
    vi.mocked(readiness.computeReadiness).mockResolvedValue({ revision: 3, ready: true, blockers: [], warnings: [] });
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'publish' }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc));
    const [, params] = rpc.mock.calls[0];
    expect(params.p_structural.drop_id).toBeNull();
  });

  it('hides without computing readiness or passing variants/media/structural', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(ceramicProduct);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'hide' }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc));
    expect(readiness.computeReadiness).not.toHaveBeenCalled();
    const [, params] = rpc.mock.calls[0];
    expect(params).toMatchObject({ p_action: 'hide', p_variants: null, p_media: null, p_structural: null });
  });

  it('maps a no_active_drop RPC error to 422', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(ceramicProduct);
    vi.mocked(readiness.computeReadiness).mockResolvedValue({ revision: 3, ready: true, blockers: [], warnings: [] });
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'no_active_drop' } });
    const res = await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'publish' }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('maps a revision_conflict RPC error to 409', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(ceramicProduct);
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=9' } });
    const res = await publicationPostRoute.handler(req({ expectedRevision: 3, action: 'hide' }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc));
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(9);
  });

  it('propagates the original publication error even when releasing the idempotency key also fails', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(ceramicProduct);
    const originalError = new Error('boom_original');
    const rpc = vi.fn().mockResolvedValue({ error: originalError });
    // First release call (inside the `if (error)` branch) succeeds; the
    // second (in the outer catch, guarding the rethrow) fails — the original
    // error must still win rather than being masked by the release failure.
    vi.mocked(idempotency.releaseIdempotencyKey)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('release_failed'));
    await expect(
      publicationPostRoute.handler(req({ expectedRevision: 3, action: 'hide' }), {} as CloudflareEnv, { id: 'prd_1' }, ctxWith(rpc)),
    ).rejects.toThrow('boom_original');
  });
});
