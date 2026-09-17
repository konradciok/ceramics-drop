import { describe, expect, it, vi, beforeEach } from 'vitest';
import { shippingRatesRestorePostRoute } from './shipping-rates-restore';
import type { HandlerContext } from '../router';
import * as mapping from '../shipping-rates-mapping';
import * as idempotency from '../idempotency';
import { SHIPPING_RATE_NAMES } from '../shipping-rates-mapping';

vi.mock('../idempotency');
vi.mock('../shipping-rates-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof mapping>()),
  loadShippingRateResource: vi.fn(),
}));

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

async function restore(body: unknown, rpc = vi.fn().mockResolvedValue({ error: null }), withKey = true, id = 'domestic') {
  const req = new Request(`https://x.test/v1/shipping-rates/${id}/restore`, {
    method: 'POST',
    headers: withKey ? { 'Idempotency-Key': 'res-1' } : {},
    body: JSON.stringify(body),
  });
  return shippingRatesRestorePostRoute.handler(req, {} as CloudflareEnv, { id }, ctxWith(rpc));
}

describe('shippingRatesRestorePostRoute', () => {
  beforeEach(() => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(mapping.loadShippingRateResource).mockResolvedValue({
      id: 'domestic',
      kind: 'shipping-rates',
      name: SHIPPING_RATE_NAMES.domestic,
      revision: 3,
      publishedRevision: 1,
      fields: [],
    });
  });

  it('404s an id that is neither track', async () => {
    const res = await restore({ expectedRevision: 2, sourceRevision: 1 }, vi.fn(), true, 'shipping-europe');
    expect(res.status).toBe(404);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await restore({ expectedRevision: 2, sourceRevision: 1 }, vi.fn(), false);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('requires both expectedRevision and sourceRevision', async () => {
    expect((await restore({ sourceRevision: 1 }, vi.fn())).status).toBe(422);
    expect((await restore({ expectedRevision: 2 }, vi.fn())).status).toBe(422);
  });

  it('restores with the rate_id and returns the new revision', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await restore({ expectedRevision: 2, sourceRevision: 1 }, rpc);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('restore_shipping_rate_draft', {
      p_rate_id: 'domestic',
      p_expected_revision: 2,
      p_source_revision: 1,
      p_actor_email: 'anna@studio.pl',
    });
    expect((await res.json()).revision).toBe(3);
  });

  it('scopes the idempotency claim to shipping-rates:restore AND the rate id', async () => {
    await restore({ expectedRevision: 2, sourceRevision: 1 }, vi.fn().mockResolvedValue({ error: null }));
    expect(idempotency.claimIdempotencyKey).toHaveBeenCalledWith(
      expect.anything(),
      'shipping-rates:restore',
      'res-1',
      { id: 'domestic', expectedRevision: 2, sourceRevision: 1 },
    );
  });

  it('maps source_revision_not_found to 404', async () => {
    const res = await restore(
      { expectedRevision: 2, sourceRevision: 99 },
      vi.fn().mockResolvedValue({ error: { message: 'source_revision_not_found' } }),
    );
    expect(res.status).toBe(404);
  });

  it('maps revision_conflict to 409 with currentRevision', async () => {
    const res = await restore(
      { expectedRevision: 2, sourceRevision: 1 },
      vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=4' } }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(4);
  });

  it('maps shipping_rate_not_found to 404', async () => {
    const res = await restore(
      { expectedRevision: 2, sourceRevision: 1 },
      vi.fn().mockResolvedValue({ error: { message: 'shipping_rate_not_found' } }),
    );
    expect(res.status).toBe(404);
  });
});
