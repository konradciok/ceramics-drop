import { describe, expect, it, vi } from 'vitest';
import { shippingRatesListRoute } from './shipping-rates-list';
import { shippingRatesGetRoute } from './shipping-rates-get';
import type { HandlerContext } from '../router';
import * as mapping from '../shipping-rates-mapping';
import { SHIPPING_RATE_IDS, SHIPPING_RATE_NAMES, type ShippingRateId, type ShippingRatesResponse } from '../shipping-rates-mapping';

vi.mock('../shipping-rates-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof mapping>()),
  loadShippingRateResource: vi.fn(),
  loadAllShippingRateResources: vi.fn(),
}));

const ctx: HandlerContext = { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };

function resource(id: ShippingRateId): ShippingRatesResponse {
  return { id, kind: 'shipping-rates', name: SHIPPING_RATE_NAMES[id], revision: 2, publishedRevision: 1, fields: [] };
}

describe('shippingRatesListRoute', () => {
  it('returns every resource as a ResourceList', async () => {
    vi.mocked(mapping.loadAllShippingRateResources).mockResolvedValue(SHIPPING_RATE_IDS.map(resource));
    const res = await shippingRatesListRoute.handler(
      new Request('https://x.test/v1/shipping-rates'),
      {} as CloudflareEnv,
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: SHIPPING_RATE_IDS.map(resource) });
  });

  it('returns an empty list (not an error) when neither row exists', async () => {
    vi.mocked(mapping.loadAllShippingRateResources).mockResolvedValue([]);
    const res = await shippingRatesListRoute.handler(
      new Request('https://x.test/v1/shipping-rates'),
      {} as CloudflareEnv,
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });
});

describe('shippingRatesGetRoute', () => {
  it.each([...SHIPPING_RATE_IDS])('returns the %s resource', async (id) => {
    vi.mocked(mapping.loadShippingRateResource).mockResolvedValue(resource(id));
    const res = await shippingRatesGetRoute.handler(
      new Request(`https://x.test/v1/shipping-rates/${id}`),
      {} as CloudflareEnv,
      { id },
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(resource(id));
  });

  it('404s an unknown id without touching the database', async () => {
    vi.mocked(mapping.loadShippingRateResource).mockClear();
    const res = await shippingRatesGetRoute.handler(
      new Request('https://x.test/v1/shipping-rates/shipping-europe'),
      {} as CloudflareEnv,
      { id: 'shipping-europe' },
      ctx,
    );
    expect(res.status).toBe(404);
    expect(mapping.loadShippingRateResource).not.toHaveBeenCalled();
  });

  it('404s when the row is absent', async () => {
    vi.mocked(mapping.loadShippingRateResource).mockResolvedValue(null);
    const res = await shippingRatesGetRoute.handler(
      new Request('https://x.test/v1/shipping-rates/domestic'),
      {} as CloudflareEnv,
      { id: 'domestic' },
      ctx,
    );
    expect(res.status).toBe(404);
  });
});
