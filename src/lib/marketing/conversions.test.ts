import { describe, it, expect, vi } from 'vitest';
import { sendPurchaseConversions, type ConversionOrder } from './conversions';

const baseOrder = (over: Partial<ConversionOrder> = {}): ConversionOrder => ({
  payment_intent_id: 'pi_1',
  subtotal: 30000, // grosze
  shipping: 1800,
  total: 31800,
  currency: 'pln',
  email: 'buyer@example.com',
  receiver_first_name: 'Anna',
  receiver_last_name: 'Nowak',
  receiver_phone: '600123456',
  shipping_address: { street: 'X', building_number: '1', city: 'Kraków', post_code: '30-001', country_code: 'PL' },
  marketing: {
    consent: 'granted', fbp: 'fb.1.1.A', fbc: null, ga_client_id: '111.222',
    ga_session_id: '999', ip: '1.2.3.4', user_agent: 'UA',
    event_source_url: 'https://anna-ciok.studio/koszyk/return', captured_at: '2026-06-09T00:00:00Z',
  },
  items: [{ product_id: 'k01', unit_price: 9000 }],
  ...over,
});

function deps(over = {}) {
  return {
    loadOrder: vi.fn().mockResolvedValue(baseOrder()),
    metaConfig: { pixelId: 'PIX', accessToken: 'TOK' },
    ga4Config: { measurementId: 'G-X', apiSecret: 'S' },
    eventTimeSecs: 1_680_000_000,
    sendMeta: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    sendGa4: vi.fn().mockResolvedValue({ ok: true, status: 204 }),
    ...over,
  };
}

describe('sendPurchaseConversions', () => {
  it('does nothing when consent is not granted', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue(baseOrder({ marketing: { ...baseOrder().marketing!, consent: 'denied' } })) });
    await sendPurchaseConversions('pi_1', d);
    expect(d.sendMeta).not.toHaveBeenCalled();
    expect(d.sendGa4).not.toHaveBeenCalled();
  });

  it('does nothing when the order or marketing context is missing', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue(null) });
    await sendPurchaseConversions('pi_1', d);
    expect(d.sendMeta).not.toHaveBeenCalled();
  });

  it('sends Meta (value=total/100) and GA4 (value=subtotal/100) with the dedup id', async () => {
    const d = deps();
    await sendPurchaseConversions('pi_1', d);
    const metaInput = d.sendMeta.mock.calls[0][1];
    expect(metaInput.eventId).toBe('purchase-pi_1');
    expect(metaInput.value).toBe(318);          // total grosze → PLN
    expect(metaInput.userData.em).toBeDefined(); // hashed email present
    expect(metaInput.userData.em[0]).toMatch(/^[0-9a-f]{64}$/);
    const ga4Input = d.sendGa4.mock.calls[0][1];
    expect(ga4Input.transactionId).toBe('pi_1');
    expect(ga4Input.value).toBe(300);            // subtotal grosze → PLN
    expect(ga4Input.shipping).toBe(18);
  });

  it('swallows a Meta failure and still attempts GA4', async () => {
    const d = deps({ sendMeta: vi.fn().mockRejectedValue(new Error('graph 500')) });
    await expect(sendPurchaseConversions('pi_1', d)).resolves.toBeUndefined();
    expect(d.sendGa4).toHaveBeenCalled();
  });
});
