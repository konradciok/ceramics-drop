import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
    env: {
      INPOST_API_URL: 'https://sandbox-api-shipx-pl.easypack24.net',
      INPOST_API_TOKEN: 'token123',
      INPOST_ORGANIZATION_ID: 'org1',
    },
  }),
}));

import { getInPost } from './inpost';

/**
 * F-finding: the adopted shipment in shipment.ts comes straight from this
 * method's return value — if ShipX's `?reference=` filter is ignored (org's
 * unfiltered page 1) or fuzzy-matches (e.g. the returns flow's
 * `return:<order.id>` reference), the wrong shipment gets adopted. These tests
 * pin the client-side exact-match filter that guards against that.
 */
describe('findShipmentsByReference (client-side exact-match filter)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops items whose reference does not exactly match, even though ShipX returned them', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { id: 1, status: 'created', tracking_number: null, reference: 'ord-1' },
          // Returns flow reference — must never be adopted as a sale shipment.
          { id: 2, status: 'created', tracking_number: null, reference: 'return:ord-1' },
          // Another order entirely — as if ShipX ignored the query param and
          // returned the org's unfiltered page 1.
          { id: 3, status: 'created', tracking_number: null, reference: 'ord-999' },
        ],
      }),
    });

    const items = await getInPost().findShipmentsByReference('ord-1');

    expect(items).toEqual([
      { id: 1, status: 'created', tracking_number: null, reference: 'ord-1' },
    ]);
  });

  it('returns empty when none of the returned items exactly match (filter ignored upstream)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { id: 10, status: 'created', tracking_number: null, reference: 'ord-other-1' },
          { id: 11, status: 'created', tracking_number: null, reference: 'return:ord-1' },
        ],
      }),
    });

    const items = await getInPost().findShipmentsByReference('ord-1');

    expect(items).toEqual([]);
  });
});
