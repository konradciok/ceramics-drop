import { describe, expect, it, vi, beforeEach } from 'vitest';
import { shippingRatesSaveRoute } from './shipping-rates-save';
import type { HandlerContext } from '../router';
import * as mapping from '../shipping-rates-mapping';
import { SHIPPING_RATE_NAMES, buildShippingRateFields } from '../shipping-rates-mapping';
import { DEFAULT_DOMESTIC_SHIPPING } from '@/lib/pricing';
import { DEFAULT_INTERNATIONAL_SHIPPING } from '@/lib/print-shipping';

vi.mock('../shipping-rates-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof mapping>()),
  loadShippingRateResource: vi.fn(),
}));

const RATES = { domestic: DEFAULT_DOMESTIC_SHIPPING, international: DEFAULT_INTERNATIONAL_SHIPPING };
const domesticFields = buildShippingRateFields('domestic', RATES);

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

async function save(body: unknown, rpc = vi.fn().mockResolvedValue({ error: null }), id = 'domestic') {
  return shippingRatesSaveRoute.handler(
    new Request(`https://x.test/v1/shipping-rates/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    {} as CloudflareEnv,
    { id },
    ctxWith(rpc),
  );
}

describe('shippingRatesSaveRoute', () => {
  beforeEach(() => {
    vi.mocked(mapping.loadShippingRateResource).mockResolvedValue({
      id: 'domestic',
      kind: 'shipping-rates',
      name: SHIPPING_RATE_NAMES.domestic,
      revision: 2,
      publishedRevision: 1,
      fields: domesticFields,
    });
  });

  it('404s an id that is neither track', async () => {
    const rpc = vi.fn();
    const res = await save({ expectedRevision: 1, name: 'x', fields: domesticFields }, rpc, 'shipping-europe');
    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('requires expectedRevision', async () => {
    const res = await save({ name: 'x', fields: domesticFields });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a null JSON body', async () => {
    const res = await save(null);
    expect(res.status).toBe(422);
  });

  it('rejects a draft wrapper', async () => {
    const res = await save({ expectedRevision: 1, draft: { name: 'x', fields: domesticFields } });
    expect(res.status).toBe(422);
  });

  it('persists {fields} only — no name key — scoped by rate_id', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await save({ expectedRevision: 1, name: 'Zignorowana nazwa', fields: domesticFields }, rpc);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('save_shipping_rate_draft', {
      p_rate_id: 'domestic',
      p_expected_revision: 1,
      p_payload: { fields: domesticFields },
      p_actor_email: 'anna@studio.pl',
    });
  });

  it('routes an international save to the international rate_id', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const fields = buildShippingRateFields('international', RATES);
    await save({ expectedRevision: 1, name: 'x', fields }, rpc, 'international');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_rate_id: 'international' });
  });

  it('accepts an out-of-range draft — ranges are a publish-time concern', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const outOfRange = domesticFields.map((f) => (f.key === 'kurier_pln' ? { ...f, value: '-5' } : f));
    const res = await save({ expectedRevision: 1, name: 'x', fields: outOfRange }, rpc);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalled();
  });

  it('maps shipping_rate_not_found to 404', async () => {
    const res = await save(
      { expectedRevision: 1, name: 'x', fields: domesticFields },
      vi.fn().mockResolvedValue({ error: { message: 'shipping_rate_not_found' } }),
    );
    expect(res.status).toBe(404);
  });

  it('maps revision_conflict to 409 with currentRevision extracted from details', async () => {
    const res = await save(
      { expectedRevision: 1, name: 'x', fields: domesticFields },
      vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=7' } }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(7);
  });

  it('returns the reloaded resource on success', async () => {
    const res = await save({ expectedRevision: 1, name: 'x', fields: domesticFields });
    expect(res.status).toBe(200);
    expect((await res.json()).revision).toBe(2);
  });
});
