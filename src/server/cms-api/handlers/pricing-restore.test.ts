import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pricingRestorePostRoute } from './pricing-restore';
import type { HandlerContext } from '../router';
import * as pricingMapping from '../pricing-mapping';
import * as idempotency from '../idempotency';
import { PRICING_RESOURCE_ID, PRICING_RESOURCE_NAME, buildPricingFields } from '../pricing-mapping';
import { DEFAULT_PRINT_PRICING } from '@/lib/print-pricing';

vi.mock('../idempotency');
vi.mock('../pricing-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof pricingMapping>()),
  loadPricingResource: vi.fn(),
}));

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

function req(body: unknown, withKey = true) {
  return new Request('https://x.test/v1/pricing/print-pricing/restore', {
    method: 'POST',
    headers: withKey ? { 'Idempotency-Key': 'res-1' } : {},
    body: JSON.stringify(body),
  });
}

async function restore(body: unknown, rpc = vi.fn().mockResolvedValue({ error: null }), withKey = true, id = PRICING_RESOURCE_ID) {
  return pricingRestorePostRoute.handler(req(body, withKey), {} as CloudflareEnv, { id }, ctxWith(rpc));
}

describe('pricingRestorePostRoute', () => {
  beforeEach(() => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(pricingMapping.loadPricingResource).mockResolvedValue({
      id: PRICING_RESOURCE_ID,
      kind: 'pricing',
      name: PRICING_RESOURCE_NAME,
      revision: 4,
      publishedRevision: 2,
      fields: buildPricingFields(DEFAULT_PRINT_PRICING),
    });
  });

  it('404s an id other than the singleton id', async () => {
    const res = await restore({ expectedRevision: 3, sourceRevision: 1 }, vi.fn(), true, 'nope');
    expect(res.status).toBe(404);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await restore({ expectedRevision: 3, sourceRevision: 1 }, vi.fn(), false);
    expect(res.status).toBe(422);
  });

  it('requires both revisions to be integers', async () => {
    expect((await restore({ sourceRevision: 1 }, vi.fn())).status).toBe(422);
    expect((await restore({ expectedRevision: 3 }, vi.fn())).status).toBe(422);
  });

  it('restores and returns the reloaded resource, leaving publishedRevision untouched', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await restore({ expectedRevision: 3, sourceRevision: 1 }, rpc);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('restore_pricing_draft', {
      p_expected_revision: 3,
      p_source_revision: 1,
      p_actor_email: 'anna@studio.pl',
    });
    const body = await res.json();
    expect(body.revision).toBe(4);
    expect(body.publishedRevision).toBe(2);
  });

  it('maps pricing_config_missing to 404', async () => {
    const res = await restore(
      { expectedRevision: 3, sourceRevision: 1 },
      vi.fn().mockResolvedValue({ error: { message: 'pricing_config_missing' } }),
    );
    expect(res.status).toBe(404);
  });

  it('maps revision_conflict to 409 with currentRevision', async () => {
    const res = await restore(
      { expectedRevision: 3, sourceRevision: 1 },
      vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=9' } }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(9);
  });

  it('maps source_revision_not_found to 404', async () => {
    const res = await restore(
      { expectedRevision: 3, sourceRevision: 99 },
      vi.fn().mockResolvedValue({ error: { message: 'source_revision_not_found' } }),
    );
    expect(res.status).toBe(404);
  });
});
