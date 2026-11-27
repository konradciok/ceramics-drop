import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  HERMES_PURCHASE_EVENT,
  buildHermesPurchasePayload,
  sendPurchaseToHermes,
  signHermesBody,
  type HermesPurchaseOrder,
} from './hermes-purchase-relay';

const order: HermesPurchaseOrder = {
  id: 'ord_1',
  payment_intent_id: 'pi_1',
  status: 'paid',
  paid_at: '2026-11-27T10:00:00.000Z',
  currency: 'pln',
  subtotal: 25000,
  shipping: 1500,
  discount: 0,
  total: 26500,
  promo_code: null,
  delivery_method: 'paczkomat',
  delivery_country: 'PL',
  items: [{ product_id: 'k01', unit_price: 25000 }],
};

describe('signHermesBody', () => {
  it('matches hex HMAC-SHA256 over "<timestamp>.<body>"', async () => {
    const expected = createHmac('sha256', 's3cret').update('1700000000.{"a":1}').digest('hex');
    expect(await signHermesBody('s3cret', '1700000000', '{"a":1}')).toBe(expected);
  });
});

describe('buildHermesPurchasePayload', () => {
  it('carries the event type and order facts but no buyer PII', () => {
    const p = buildHermesPurchasePayload({
      ...order,
      // extra fields that must never leak even if a caller passes a wider row
      ...({ email: 'a@b.c', receiver_first_name: 'Ann', shipping_address: { street: 'x' } } as object),
    });
    expect(p.event_type).toBe(HERMES_PURCHASE_EVENT);
    expect(p.total_display).toBe('265.00 PLN');
    expect(p.item_count).toBe(1);
    const json = JSON.stringify(p);
    expect(json).not.toContain('a@b.c');
    expect(json).not.toContain('Ann');
    expect(json).not.toContain('street');
  });
});

describe('sendPurchaseToHermes', () => {
  const base = () => ({
    loadOrder: vi.fn().mockResolvedValue(order),
    url: 'https://hermes.example.com/webhooks/zakup',
    secret: 'whsec_test',
    nowSeconds: () => 1700000000,
  });

  it('is a no-op without URL or secret', async () => {
    const fetchImpl = vi.fn();
    expect(await sendPurchaseToHermes('pi_1', { ...base(), url: undefined, fetchImpl })).toBe(false);
    expect(await sendPurchaseToHermes('pi_1', { ...base(), secret: ' ', fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a signed, deduplicable request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    expect(await sendPurchaseToHermes('pi_1', { ...base(), fetchImpl })).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://hermes.example.com/webhooks/zakup');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-webhook-timestamp']).toBe('1700000000');
    expect(headers['x-request-id']).toBe('purchase-pi_1');
    expect(headers['x-webhook-signature-v2']).toBe(
      createHmac('sha256', 'whsec_test').update(`1700000000.${init.body}`).digest('hex'),
    );
    expect(JSON.parse(init.body).event_type).toBe('purchase.paid');
  });

  it('skips orders that are not paid', async () => {
    const fetchImpl = vi.fn();
    const loadOrder = vi.fn().mockResolvedValue({ ...order, status: 'failed' });
    expect(await sendPurchaseToHermes('pi_1', { ...base(), loadOrder, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws on a non-2xx or a network error', async () => {
    const non2xx = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
    expect(await sendPurchaseToHermes('pi_1', { ...base(), fetchImpl: non2xx })).toBe(false);
    const boom = vi.fn().mockRejectedValue(new Error('network'));
    expect(await sendPurchaseToHermes('pi_1', { ...base(), fetchImpl: boom })).toBe(false);
  });
});
