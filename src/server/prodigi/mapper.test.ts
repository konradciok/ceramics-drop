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

// Legacy ceramic-shaped address retained to prove old JSONB rows remain readable.
const order = {
  id: 'order-123',
  currency: 'eur' as const,
  email: 'jan@example.com',
  receiver_first_name: 'Jan',
  receiver_last_name: 'Kowalski',
  receiver_phone: null,
  shipping_address: { street: 'ul. Marszałkowska', building_number: '1', city: 'Warszawa', post_code: '00-001', country_code: 'PL' },
  delivery_method: 'kurier',
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
    assetId: 'asset-uuid-1',
    assetKey: 'prints/fap01/rev1/4800x7200-abc.jpg',
    assetSha256: 'a'.repeat(64),
    assetContentType: 'image/jpeg' as const,
    assetWidthPx: 4800,
    assetHeightPx: 7200,
  },
};

const assetUrls = { 'asset-uuid-1': 'https://example.com/asset.jpg' };

describe('buildProdigiPayload', () => {
  it('sets correct idempotency key', () => {
    const payload = buildProdigiPayload(order, [printItem], assetUrls, mockEnv);
    expect(payload.idempotencyKey).toBe('prodigi:sandbox:order:order-123:v1');
  });

  it('maps EUR unit_price to recipientCost correctly', () => {
    const payload = buildProdigiPayload(order, [printItem], assetUrls, mockEnv);
    expect(payload.items[0].recipientCost).toEqual({ amount: '35.00', currency: 'EUR' });
  });

  it('sets mount attributes for CFPM', () => {
    const payload = buildProdigiPayload(order, [printItem], assetUrls, mockEnv);
    expect(payload.items[0].attributes).toEqual({ color: 'natural', mount: '2.4mm', mountColor: 'Snow white' });
  });

  it('sets no attributes for unframed FAP', () => {
    const unframed = { ...printItem, variant: { ...printItem.variant, prodigiSku: 'GLOBAL-FAP-20X28', framed: false, mount: false, frameColour: 'none' } };
    const payload = buildProdigiPayload(order, [unframed], assetUrls, mockEnv);
    expect(payload.items[0].attributes).toEqual({});
  });

  it('uses sandbox callback URL', () => {
    const payload = buildProdigiPayload(order, [printItem], assetUrls, mockEnv);
    expect(payload.callbackUrl).toContain('/api/webhooks/prodigi/test-token');
  });

  it('uses WORKER_ORIGIN when set', () => {
    const payload = buildProdigiPayload(order, [printItem], assetUrls, {
      ...mockEnv,
      WORKER_ORIGIN: 'https://staging.anna-ciok.studio',
    });
    expect(payload.callbackUrl).toBe('https://staging.anna-ciok.studio/api/webhooks/prodigi/test-token');
  });

  it('maps the ShipX address + receiver columns to the Prodigi recipient', () => {
    const payload = buildProdigiPayload(order, [printItem], assetUrls, mockEnv);
    expect(payload.recipient).toEqual({
      name: 'Jan Kowalski',
      email: 'jan@example.com',
      phoneNumber: undefined,
      address: {
        line1: 'ul. Marszałkowska 1',
        postalOrZipCode: '00-001',
        countryCode: 'PL',
        townOrCity: 'Warszawa',
      },
    });
  });

  it('maps native print line1 and line2 to Prodigi without loss', () => {
    const payload = buildProdigiPayload({
      ...order,
      receiver_phone: '+442079460958',
      shipping_address: {
        line1: '221B Baker Street',
        line2: 'Flat B',
        city: 'London',
        post_code: 'NW1',
        country_code: 'GB',
      },
    }, [printItem], assetUrls, mockEnv);
    expect(payload.recipient).toMatchObject({
      phoneNumber: '+442079460958',
      address: {
        line1: '221B Baker Street',
        line2: 'Flat B',
        postalOrZipCode: 'NW1',
        countryCode: 'GB',
        townOrCity: 'London',
      },
    });
  });

  it('throws when the order has no shipping address', () => {
    expect(() =>
      buildProdigiPayload({ ...order, shipping_address: null }, [printItem], assetUrls, mockEnv),
    ).toThrow(/no shipping_address/);
  });

  it('throws when an asset URL is missing', () => {
    expect(() => buildProdigiPayload(order, [printItem], {}, mockEnv)).toThrow(/asset URL/);
  });

  it('throws when snapshot dimensions do not match printAreaPx', () => {
    const mismatched = {
      ...printItem,
      variant: { ...printItem.variant, assetWidthPx: 3600, assetHeightPx: 4800 },
    };
    expect(() => buildProdigiPayload(order, [mismatched], assetUrls, mockEnv)).toThrow(/do not match print area/);
  });

  it('keys asset URLs by assetId so mixed sizes of the same design get distinct URLs', () => {
    const small = {
      ...printItem,
      variant: { ...printItem.variant, assetId: 'asset-small', assetWidthPx: 3600, assetHeightPx: 4800, printAreaPx: { w: 3600, h: 4800 } },
    };
    const large = printItem;
    const urls = {
      'asset-small': 'https://example.com/small.jpg',
      'asset-uuid-1': 'https://example.com/large.jpg',
    };
    const payload = buildProdigiPayload(order, [small, large], urls, mockEnv);
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0].assets[0].url).toBe('https://example.com/small.jpg');
    expect(payload.items[1].assets[0].url).toBe('https://example.com/large.jpg');
  });
});
