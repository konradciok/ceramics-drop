import { describe, it, expect, vi } from 'vitest';
import { buildMetaPurchasePayload, sendMetaPurchase, type MetaPurchaseInput } from './meta-capi';

const input = (): MetaPurchaseInput => ({
  eventId: 'purchase-pi_1',
  eventTimeSecs: 1_680_000_000,
  eventSourceUrl: 'https://anna-ciok.studio/koszyk/return',
  userData: { em: ['HASH_EM'], client_ip_address: '1.2.3.4', client_user_agent: 'UA', fbp: 'fb.1.1.A', fbc: null },
  value: 318,
  currency: 'PLN',
  contentIds: ['k01', 'v01'],
  contents: [{ id: 'k01', quantity: 1, item_price: 90 }, { id: 'v01', quantity: 1, item_price: 210 }],
  numItems: 2,
  orderId: 'pi_1',
});

describe('buildMetaPurchasePayload', () => {
  it('builds a single Purchase event with dedup id and no null fbc key', () => {
    const payload = buildMetaPurchasePayload(input());
    expect(payload.data).toHaveLength(1);
    const e = payload.data[0];
    expect(e.event_name).toBe('Purchase');
    expect(e.event_id).toBe('purchase-pi_1');
    expect(e.action_source).toBe('website');
    expect(e.user_data.fbc).toBeUndefined(); // null pruned
    expect(e.user_data.fbp).toBe('fb.1.1.A');
    expect(e.custom_data).toMatchObject({ currency: 'PLN', value: 318, num_items: 2, order_id: 'pi_1' });
    expect(e.custom_data.contents).toHaveLength(2);
  });
});

describe('sendMetaPurchase', () => {
  it('POSTs to the graph endpoint and reports ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    const res = await sendMetaPurchase(
      { pixelId: 'PIX', accessToken: 'TOK' },
      input(),
      fetchImpl,
    );
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://graph.facebook.com/');
    expect(url).toContain('/PIX/events');
    expect(url).toContain('access_token=TOK');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).not.toHaveProperty('test_event_code');
  });

  it('includes test_event_code when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    await sendMetaPurchase({ pixelId: 'PIX', accessToken: 'TOK', testEventCode: 'TEST123' }, input(), fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).test_event_code).toBe('TEST123');
  });
});
