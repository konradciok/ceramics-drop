import { describe, expect, it, vi, beforeEach } from 'vitest';
import { shippingRatesPublicationPostRoute } from './shipping-rates-publication';
import type { HandlerContext } from '../router';
import * as mapping from '../shipping-rates-mapping';
import * as idempotency from '../idempotency';
import { SHIPPING_RATE_NAMES, buildShippingRateFields, type ShippingRateId } from '../shipping-rates-mapping';
import { DEFAULT_DOMESTIC_SHIPPING } from '@/lib/pricing';
import { DEFAULT_INTERNATIONAL_SHIPPING } from '@/lib/print-shipping';
import type { Field } from '../types';

vi.mock('../idempotency');
vi.mock('../shipping-rates-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof mapping>()),
  loadShippingRateResource: vi.fn(),
}));

const RATES = { domestic: DEFAULT_DOMESTIC_SHIPPING, international: DEFAULT_INTERNATIONAL_SHIPPING };
const validFields = buildShippingRateFields('domestic', RATES);

function currentIs(revision: number, fields: Field[] = validFields, id: ShippingRateId = 'domestic') {
  vi.mocked(mapping.loadShippingRateResource).mockResolvedValue({
    id,
    kind: 'shipping-rates',
    name: SHIPPING_RATE_NAMES[id],
    revision,
    publishedRevision: 1,
    fields,
  });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

async function publish(body: unknown, rpc = vi.fn().mockResolvedValue({ error: null }), withKey = true, id = 'domestic') {
  const req = new Request(`https://x.test/v1/shipping-rates/${id}/publication`, {
    method: 'POST',
    headers: withKey ? { 'Idempotency-Key': 'pub-1' } : {},
    body: JSON.stringify(body),
  });
  return shippingRatesPublicationPostRoute.handler(req, {} as CloudflareEnv, { id }, ctxWith(rpc));
}

describe('shippingRatesPublicationPostRoute', () => {
  beforeEach(() => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    currentIs(2);
  });

  it('404s an id that is neither track, before claiming an idempotency key', async () => {
    const res = await publish({ expectedRevision: 2 }, vi.fn(), true, 'shipping-europe');
    expect(res.status).toBe(404);
    expect(idempotency.claimIdempotencyKey).not.toHaveBeenCalled();
  });

  it('requires an Idempotency-Key', async () => {
    const res = await publish({ expectedRevision: 2 }, vi.fn(), false);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('requires an integer expectedRevision', async () => {
    const res = await publish({ expectedRevision: 1.5 }, vi.fn());
    expect(res.status).toBe(422);
  });

  it('publishes with the rate_id and returns the reloaded resource', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await publish({ expectedRevision: 2 }, rpc);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('publish_shipping_rate_revision', {
      p_rate_id: 'domestic',
      p_expected_revision: 2,
      p_actor_email: 'anna@studio.pl',
    });
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalled();
  });

  it('scopes the idempotency claim to shipping-rates:publication AND the rate id', async () => {
    await publish({ expectedRevision: 2 }, vi.fn().mockResolvedValue({ error: null }));
    expect(idempotency.claimIdempotencyKey).toHaveBeenCalledWith(
      expect.anything(),
      'shipping-rates:publication',
      'pub-1',
      { id: 'domestic', expectedRevision: 2 },
    );
  });

  it('pre-flights the current draft and 422s per-field before reaching the RPC', async () => {
    currentIs(2, validFields.map((f) => (f.key === 'kurier_pln' ? { ...f, value: '-1' } : f)));
    const rpc = vi.fn();
    const res = await publish({ expectedRevision: 2 }, rpc);
    expect(res.status).toBe(422);
    expect((await res.json()).fieldErrors).toHaveProperty('kurier_pln');
    expect(rpc).not.toHaveBeenCalled();
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('skips the pre-flight when the client is publishing a stale revision, so the RPC conflict wins', async () => {
    currentIs(5, validFields.map((f) => (f.key === 'kurier_pln' ? { ...f, value: '-1' } : f)));
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=5' } });
    const res = await publish({ expectedRevision: 2 }, rpc);
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(5);
  });

  it('maps draft_required to 422', async () => {
    const res = await publish({ expectedRevision: 2 }, vi.fn().mockResolvedValue({ error: { message: 'draft_required' } }));
    expect(res.status).toBe(422);
  });

  it('maps shipping_rate_not_found to 404', async () => {
    const res = await publish({ expectedRevision: 2 }, vi.fn().mockResolvedValue({ error: { message: 'shipping_rate_not_found' } }));
    expect(res.status).toBe(404);
  });

  it('maps shipping_rates_invalid to a 422 keyed by every key the RPC flagged', async () => {
    const res = await publish(
      { expectedRevision: 2 },
      vi.fn().mockResolvedValue({ error: { message: 'shipping_rates_invalid', details: 'invalidKeys=kurier_pln,odbior_gbp' } }),
    );
    expect(res.status).toBe(422);
    expect(Object.keys((await res.json()).fieldErrors)).toEqual(['kurier_pln', 'odbior_gbp']);
  });

  it('404s when the row vanished between the claim and the read', async () => {
    vi.mocked(mapping.loadShippingRateResource).mockResolvedValue(null);
    const res = await publish({ expectedRevision: 2 }, vi.fn());
    expect(res.status).toBe(404);
  });

  it('replays a completed key without re-running the RPC', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 200, body: { id: 'domestic' } });
    const rpc = vi.fn();
    const res = await publish({ expectedRevision: 2 }, rpc);
    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('409s an in-progress key', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'in_progress' });
    const res = await publish({ expectedRevision: 2 }, vi.fn());
    expect(res.status).toBe(409);
  });

  it('422s a reused key carrying a different body', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'key_reuse' });
    const res = await publish({ expectedRevision: 2 }, vi.fn());
    expect(res.status).toBe(422);
  });

  it('validates the international resource against its own 56 keys', async () => {
    const intl = buildShippingRateFields('international', RATES);
    currentIs(2, intl.map((f) => (f.key === 'gb_framed_eur' ? { ...f, value: '' } : f)), 'international');
    const rpc = vi.fn();
    const res = await publish({ expectedRevision: 2 }, rpc, true, 'international');
    expect(res.status).toBe(422);
    expect((await res.json()).fieldErrors).toHaveProperty('gb_framed_eur');
    expect(rpc).not.toHaveBeenCalled();
  });
});
