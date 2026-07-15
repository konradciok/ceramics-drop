import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable env so each test can flip FULFILMENT_DEBUG_TOKEN (fail-closed gate).
const ENV = vi.hoisted(() => ({ FULFILMENT_DEBUG_TOKEN: 'tok_good' as string | undefined }));

// Chainable supabase stub: from(table) ... .select().eq()[.maybeSingle()] resolves
// to the configured { data, error } for that table. Awaiting a bare chain (no
// maybeSingle) also resolves — covers the prodigi_orders array select.
const SUPA = vi.hoisted(() => {
  const results: Record<string, { data: unknown; error: unknown }> = {};
  const build = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve(results[table] ?? { data: null, error: null }),
    };
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(results[table] ?? { data: null, error: null }).then(resolve, reject);
    return chain;
  };
  return { from: build, results };
});

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: () => ({ env: ENV }) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => SUPA }));

import { GET } from './route';

function req(paymentIntent: string | null, token: string | null = 'tok_good') {
  const qs = paymentIntent ? `?payment_intent=${paymentIntent}` : '';
  const headers = new Headers();
  if (token) headers.set('x-fulfilment-debug-token', token);
  return new Request(`http://localhost/api/debug/fulfilment-status${qs}`, { headers });
}

describe('GET /api/debug/fulfilment-status', () => {
  beforeEach(() => {
    ENV.FULFILMENT_DEBUG_TOKEN = 'tok_good';
    for (const k of Object.keys(SUPA.results)) delete SUPA.results[k];
  });

  it('is fail-closed: 404 when FULFILMENT_DEBUG_TOKEN is unset (no prod surface)', async () => {
    ENV.FULFILMENT_DEBUG_TOKEN = undefined;
    const res = await GET(req('pi_123'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('rejects a missing/wrong token with 401 before any lookup', async () => {
    expect((await GET(req('pi_123', null))).status).toBe(401);
    expect((await GET(req('pi_123', 'tok_bad'))).status).toBe(401);
  });

  it('rejects a missing or non-pi_ payment_intent with 400 (valid token)', async () => {
    expect((await GET(req(null))).status).toBe(400);
    expect((await GET(req('not-a-pi'))).status).toBe(400);
  });

  it('returns nulls while the order row has not landed yet (keep polling)', async () => {
    SUPA.results.orders = { data: null, error: null };
    const res = await GET(req('pi_123'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fulfilmentStatus: null, prodigiOrderId: null });
  });

  it('returns the fulfilment shape once the job submitted and Prodigi accepted', async () => {
    SUPA.results.orders = { data: { id: 'ord-1' }, error: null };
    SUPA.results.fulfilment_jobs = { data: { status: 'fulfilment_submitted' }, error: null };
    SUPA.results.prodigi_orders = {
      data: [{ prodigi_order_id: 'prd_abc' }],
      error: null,
    };
    const res = await GET(req('pi_123'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fulfilmentStatus: 'fulfilment_submitted',
      prodigiOrderId: 'prd_abc',
    });
  });

  it('maps a prodigi_orders row with a null id to prodigiOrderId null', async () => {
    SUPA.results.orders = { data: { id: 'ord-1' }, error: null };
    SUPA.results.fulfilment_jobs = { data: { status: 'queued' }, error: null };
    SUPA.results.prodigi_orders = { data: [{ prodigi_order_id: null }], error: null };
    const res = await GET(req('pi_123'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fulfilmentStatus: 'queued', prodigiOrderId: null });
  });

  it('returns 500 when the order lookup errors', async () => {
    SUPA.results.orders = { data: null, error: { message: 'boom' } };
    const res = await GET(req('pi_123'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'lookup_failed' });
  });
});
