import { describe, it, expect } from 'vitest';
import { buildProdigiPayload } from './mapper';

const mockEnv = {
  PRODIGI_ENV: 'sandbox',
  PRODIGI_DEFAULT_SHIPPING_METHOD: 'Budget',
  PRODIGI_CALLBACK_TOKEN: 'test-token',
  PRODIGI_API_KEY_SANDBOX: 'key',
  PRODIGI_API_KEY_LIVE: '',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const order = {
  id: 'order-123',
  currency: 'eur' as const,
  contact: { name: 'Jan Kowalski', email: 'jan@example.com' },
  shipping_address: { line1: 'ul. Marszałkowska 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
  delivery_method: 'prodigi',
};

const printItem = {
  product_id: 'fap01',
  unit_price: 3500, // 35 EUR in euro-cents
  variant: {
    prodigiSku: 'GLOBAL-CFPM-20X28',
    framed: true,
    mount: true,
    frameColour: 'natural',
    printAreaPx: { w: 4800, h: 7200 },
  },
};

describe('buildProdigiPayload', () => {
  it('sets correct idempotency key', () => {
    const payload = buildProdigiPayload(order, [printItem], { fap01: 'https://example.com/asset.jpg' }, mockEnv);
    expect(payload.idempotencyKey).toBe('prodigi:sandbox:order:order-123:v1');
  });

  it('maps EUR unit_price to recipientCost correctly', () => {
    const payload = buildProdigiPayload(order, [printItem], { fap01: 'https://example.com/asset.jpg' }, mockEnv);
    expect(payload.items[0].recipientCost).toEqual({ amount: '35.00', currency: 'EUR' });
  });

  it('sets mount attributes for CFPM', () => {
    const payload = buildProdigiPayload(order, [printItem], { fap01: 'https://example.com/asset.jpg' }, mockEnv);
    expect(payload.items[0].attributes).toEqual({ color: 'natural', mount: '2.4mm', mountColor: 'Snow white' });
  });

  it('sets no attributes for unframed FAP', () => {
    const unframed = { ...printItem, variant: { ...printItem.variant, prodigiSku: 'GLOBAL-FAP-20X28', framed: false, mount: false, frameColour: 'none' } };
    const payload = buildProdigiPayload(order, [unframed], { fap01: 'https://example.com/asset.jpg' }, mockEnv);
    expect(payload.items[0].attributes).toEqual({});
  });

  it('uses sandbox callback URL', () => {
    const payload = buildProdigiPayload(order, [printItem], { fap01: 'https://example.com/asset.jpg' }, mockEnv);
    expect(payload.callbackUrl).toContain('/api/webhooks/prodigi/test-token');
  });
});
