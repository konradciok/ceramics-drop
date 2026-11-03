import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pricingSaveRoute } from './pricing-save';
import type { HandlerContext } from '../router';
import * as pricingMapping from '../pricing-mapping';
import { PRICING_RESOURCE_ID, PRICING_RESOURCE_NAME, buildPricingFields } from '../pricing-mapping';
import { DEFAULT_PRINT_PRICING } from '@/lib/print-pricing';

vi.mock('../pricing-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof pricingMapping>()),
  loadPricingResource: vi.fn(),
}));

const validFields = buildPricingFields(DEFAULT_PRINT_PRICING);

function req(body: unknown) {
  return new Request('https://x.test/v1/pricing/print-pricing', { method: 'PUT', body: JSON.stringify(body) });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

async function save(body: unknown, rpc = vi.fn().mockResolvedValue({ error: null }), id = PRICING_RESOURCE_ID) {
  return pricingSaveRoute.handler(req(body), {} as CloudflareEnv, { id }, ctxWith(rpc));
}

describe('pricingSaveRoute', () => {
  beforeEach(() => {
    vi.mocked(pricingMapping.loadPricingResource).mockResolvedValue({
      id: PRICING_RESOURCE_ID,
      kind: 'pricing',
      name: PRICING_RESOURCE_NAME,
      revision: 2,
      publishedRevision: 1,
      fields: validFields,
    });
  });

  it('404s an id other than the singleton id', async () => {
    const res = await save({ expectedRevision: 1, name: 'x', fields: validFields }, vi.fn(), 'nope');
    expect(res.status).toBe(404);
  });

  it('requires expectedRevision', async () => {
    const res = await save({ name: 'x', fields: validFields });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a null JSON body', async () => {
    const res = await save(null);
    expect(res.status).toBe(422);
  });

  it('rejects a draft wrapper', async () => {
    const res = await save({ expectedRevision: 1, draft: { name: 'x', fields: validFields } });
    expect(res.status).toBe(422);
  });

  it('persists {fields} only — no name key — matching pricing_config_drafts.payload', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await save({ expectedRevision: 1, name: 'Zignorowana nazwa', fields: validFields }, rpc);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('save_pricing_draft', {
      p_expected_revision: 1,
      p_payload: { fields: validFields },
      p_actor_email: 'anna@studio.pl',
    });
  });

  it('accepts an out-of-range draft — ranges are a publish-time concern', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const outOfRange = validFields.map((f) => (f.key === 'base_30x40_eur' ? { ...f, value: '0' } : f));
    const res = await save({ expectedRevision: 1, name: 'x', fields: outOfRange }, rpc);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalled();
  });

  it('maps pricing_config_missing to 404', async () => {
    const res = await save(
      { expectedRevision: 1, name: 'x', fields: validFields },
      vi.fn().mockResolvedValue({ error: { message: 'pricing_config_missing' } }),
    );
    expect(res.status).toBe(404);
  });

  it('maps revision_conflict to 409 with currentRevision extracted from details', async () => {
    const res = await save(
      { expectedRevision: 1, name: 'x', fields: validFields },
      vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=7' } }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(7);
  });

  it('returns the reloaded resource on success', async () => {
    const res = await save({ expectedRevision: 1, name: 'x', fields: validFields });
    expect(res.status).toBe(200);
    expect((await res.json()).revision).toBe(2);
  });
});
