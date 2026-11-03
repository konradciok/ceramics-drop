import { describe, expect, it, vi } from 'vitest';
import { pricingListRoute } from './pricing-list';
import { pricingGetRoute } from './pricing-get';
import type { HandlerContext } from '../router';
import * as pricingMapping from '../pricing-mapping';
import { PRICING_RESOURCE_ID, PRICING_RESOURCE_NAME } from '../pricing-mapping';

vi.mock('../pricing-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof pricingMapping>()),
  loadPricingResource: vi.fn(),
}));

const ctx: HandlerContext = { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };

const resource = {
  id: PRICING_RESOURCE_ID,
  kind: 'pricing' as const,
  name: PRICING_RESOURCE_NAME,
  revision: 2,
  publishedRevision: 1,
  fields: [],
};

describe('pricingListRoute', () => {
  it('returns the singleton as a one-item ResourceList', async () => {
    vi.mocked(pricingMapping.loadPricingResource).mockResolvedValue(resource);
    const res = await pricingListRoute.handler(
      new Request('https://x.test/v1/pricing'),
      {} as CloudflareEnv,
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [resource] });
  });

  it('returns an empty list (not an error) when the live singleton row is absent', async () => {
    vi.mocked(pricingMapping.loadPricingResource).mockResolvedValue(null);
    const res = await pricingListRoute.handler(
      new Request('https://x.test/v1/pricing'),
      {} as CloudflareEnv,
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });
});

describe('pricingGetRoute', () => {
  it('returns the singleton for the well-known id', async () => {
    vi.mocked(pricingMapping.loadPricingResource).mockResolvedValue(resource);
    const res = await pricingGetRoute.handler(
      new Request('https://x.test/v1/pricing/print-pricing'),
      {} as CloudflareEnv,
      { id: PRICING_RESOURCE_ID },
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(resource);
  });

  it('404s any other id without touching the database', async () => {
    vi.mocked(pricingMapping.loadPricingResource).mockClear();
    const res = await pricingGetRoute.handler(
      new Request('https://x.test/v1/pricing/shipping-europe'),
      {} as CloudflareEnv,
      { id: 'shipping-europe' },
      ctx,
    );
    expect(res.status).toBe(404);
    expect(pricingMapping.loadPricingResource).not.toHaveBeenCalled();
  });

  it('404s when the live singleton row is absent', async () => {
    vi.mocked(pricingMapping.loadPricingResource).mockResolvedValue(null);
    const res = await pricingGetRoute.handler(
      new Request('https://x.test/v1/pricing/print-pricing'),
      {} as CloudflareEnv,
      { id: PRICING_RESOURCE_ID },
      ctx,
    );
    expect(res.status).toBe(404);
  });
});
