import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pricingPublicationPostRoute } from './pricing-publication';
import type { HandlerContext } from '../router';
import * as pricingMapping from '../pricing-mapping';
import * as idempotency from '../idempotency';
import { PRICING_RESOURCE_ID, PRICING_RESOURCE_NAME, buildPricingFields } from '../pricing-mapping';
import { DEFAULT_PRINT_PRICING } from '@/lib/print-pricing';
import type { Field } from '../types';

vi.mock('../idempotency');
vi.mock('../pricing-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof pricingMapping>()),
  loadPricingResource: vi.fn(),
}));

const validFields = buildPricingFields(DEFAULT_PRINT_PRICING);

function currentIs(revision: number, fields: Field[] = validFields, publishedRevision: number | null = 1) {
  vi.mocked(pricingMapping.loadPricingResource).mockResolvedValue({
    id: PRICING_RESOURCE_ID,
    kind: 'pricing',
    name: PRICING_RESOURCE_NAME,
    revision,
    publishedRevision,
    fields,
  });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

function req(body: unknown, withKey = true) {
  return new Request('https://x.test/v1/pricing/print-pricing/publication', {
    method: 'POST',
    headers: withKey ? { 'Idempotency-Key': 'pub-1' } : {},
    body: JSON.stringify(body),
  });
}

async function publish(body: unknown, rpc = vi.fn().mockResolvedValue({ error: null }), withKey = true, id = PRICING_RESOURCE_ID) {
  return pricingPublicationPostRoute.handler(req(body, withKey), {} as CloudflareEnv, { id }, ctxWith(rpc));
}

describe('pricingPublicationPostRoute', () => {
  beforeEach(() => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    currentIs(2);
  });

  it('404s an id other than the singleton id', async () => {
    const res = await publish({ expectedRevision: 2 }, vi.fn(), true, 'nope');
    expect(res.status).toBe(404);
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

  it('publishes and returns the reloaded resource', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await publish({ expectedRevision: 2 }, rpc);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('publish_pricing_revision', {
      p_expected_revision: 2,
      p_actor_email: 'anna@studio.pl',
    });
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalled();
  });

  // --- the publish-time range gate ----------------------------------------
  it('refuses to publish an out-of-range draft, with per-field errors, and never calls the RPC', async () => {
    currentIs(2, validFields.map((f) => (f.key === 'base_50x70_eur' ? { ...f, value: '0' } : f)));
    const rpc = vi.fn();
    const res = await publish({ expectedRevision: 2 }, rpc);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors).toHaveProperty('base_50x70_eur');
    expect(rpc).not.toHaveBeenCalled();
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('refuses to publish a draft missing one of the 11 keys', async () => {
    currentIs(2, validFields.filter((f) => f.key !== 'eur_to_gbp'));
    const rpc = vi.fn();
    const res = await publish({ expectedRevision: 2 }, rpc);
    expect(res.status).toBe(422);
    expect((await res.json()).fieldErrors).toHaveProperty('eur_to_gbp');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('skips the pre-flight when the client is publishing a stale revision, so revision_conflict wins', async () => {
    currentIs(5, validFields.map((f) => (f.key === 'base_50x70_eur' ? { ...f, value: '0' } : f)));
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=5' } });
    const res = await publish({ expectedRevision: 2 }, rpc);
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(5);
  });

  // --- RPC error mapping ---------------------------------------------------
  it('maps pricing_config_missing to 404', async () => {
    const res = await publish({ expectedRevision: 2 }, vi.fn().mockResolvedValue({ error: { message: 'pricing_config_missing' } }));
    expect(res.status).toBe(404);
  });

  it('maps draft_required to 422', async () => {
    const res = await publish({ expectedRevision: 2 }, vi.fn().mockResolvedValue({ error: { message: 'draft_required' } }));
    expect(res.status).toBe(422);
  });

  it('maps pricing_invalid to 422 with one fieldError per key parsed from invalidKeys=', async () => {
    const res = await publish(
      { expectedRevision: 2 },
      vi.fn().mockResolvedValue({ error: { message: 'pricing_invalid', details: 'invalidKeys=base_30x40_eur,eur_to_pln' } }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(Object.keys(body.fieldErrors).sort()).toEqual(['base_30x40_eur', 'eur_to_pln']);
  });

  it('404s when the live singleton row is absent', async () => {
    vi.mocked(pricingMapping.loadPricingResource).mockResolvedValue(null);
    const res = await publish({ expectedRevision: 2 }, vi.fn());
    expect(res.status).toBe(404);
  });

  // --- idempotency ---------------------------------------------------------
  it('replays a completed key without calling the RPC again', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 200, body: { replayed: true } });
    const rpc = vi.fn();
    const res = await publish({ expectedRevision: 2 }, rpc);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ replayed: true });
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

  it('releases the lease and rethrows on an unmapped RPC error', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'some_unexpected_pg_error' } });
    await expect(publish({ expectedRevision: 2 }, rpc)).rejects.toBeTruthy();
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });
});
