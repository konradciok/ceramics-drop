import { describe, expect, it } from 'vitest';
import {
  printDeliveryContactSchema,
  printShippingAddressSchema,
  validatePrintDelivery,
} from './print-delivery';

const address = {
  line1: '  Hauptstraße 12  ',
  city: ' Berlin ',
  post_code: ' D-10115 ',
  country_code: 'DE',
};

describe('print delivery schema', () => {
  it.each([
    ['PL', '+48 501 234 567', '+48501234567'],
    ['DE', '030 123456', '+4930123456'],
    ['GB', '020 7946 0958', '+442079460958'],
  ] as const)('normalizes a valid %s phone to E.164', (country, raw, normalized) => {
    expect(printDeliveryContactSchema(country).parse({
      first_name: ' Anna ',
      last_name: ' Ciok ',
      email: ' ANNA@EXAMPLE.COM ',
      phone: raw,
    })).toEqual({
      first_name: 'Anna',
      last_name: 'Ciok',
      email: 'anna@example.com',
      phone: normalized,
    });
  });

  it('rejects a phone that is invalid for the destination country', () => {
    expect(printDeliveryContactSchema('DE').safeParse({
      first_name: 'Anna', last_name: 'Ciok', email: 'anna@example.com', phone: '123',
    }).success).toBe(false);
  });

  it('rejects a plausible-length phone with an invalid numbering pattern', () => {
    expect(printDeliveryContactSchema('DE').safeParse({
      first_name: 'Anna', last_name: 'Ciok', email: 'anna@example.com', phone: '+49 123 4567890',
    }).success).toBe(false);
  });

  it('accepts a valid international phone from outside the delivery country', () => {
    expect(printDeliveryContactSchema('DE').parse({
      first_name: 'Anna', last_name: 'Ciok', email: 'anna@example.com', phone: '+48 501 234 567',
    }).phone).toBe('+48501234567');
  });

  it('accepts an optional line2 and a tolerant postal code', () => {
    expect(printShippingAddressSchema.parse({ ...address, line2: ' Apt 4 / floor 2 ' })).toEqual({
      line1: 'Hauptstraße 12',
      line2: 'Apt 4 / floor 2',
      city: 'Berlin',
      post_code: 'D-10115',
      country_code: 'DE',
    });
    expect(printShippingAddressSchema.parse({ ...address, line2: '  ' }).line2).toBeUndefined();
  });

  it('rejects unsupported countries and field limits', () => {
    expect(printShippingAddressSchema.safeParse({ ...address, country_code: 'US' }).success).toBe(false);
    expect(printShippingAddressSchema.safeParse({ ...address, line1: 'x'.repeat(121) }).success).toBe(false);
    expect(printShippingAddressSchema.safeParse({ ...address, post_code: 'x'.repeat(21) }).success).toBe(false);
    expect(printDeliveryContactSchema('PL').safeParse({
      first_name: 'x'.repeat(101), last_name: 'Ciok', email: 'a@example.com', phone: '+48501234567',
    }).success).toBe(false);
  });

  it('classifies method, address, and contact failures without accepting partial data', () => {
    const valid = {
      delivery_method: 'kurier',
      address,
      contact: { first_name: 'Anna', last_name: 'Ciok', email: 'A@EXAMPLE.COM', phone: '030 123456' },
    };
    expect(validatePrintDelivery(valid)).toMatchObject({
      ok: true,
      delivery: { contact: { email: 'a@example.com', phone: '+4930123456' } },
    });
    expect(validatePrintDelivery({ ...valid, delivery_method: 'paczkomat' })).toEqual({ ok: false, reason: 'invalid_delivery' });
    expect(validatePrintDelivery({ ...valid, address: { ...address, line1: '' } })).toEqual({ ok: false, reason: 'invalid_address' });
    expect(validatePrintDelivery({ ...valid, contact: { ...valid.contact, phone: '123' } })).toEqual({ ok: false, reason: 'invalid_contact' });
  });
});
