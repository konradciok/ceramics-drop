import { describe, it, expect } from 'vitest';
import { validateDelivery, needsShipment } from './validate';
import { CHECKOUT_DELIVERY_METHODS, COURIER_ENABLED, STUDIO_PICKUP_ENABLED } from '@/lib/pricing';

const contact = { first_name: 'Anna', last_name: 'Kowalska', email: 'a@example.com', phone: '+48600100200' };
const address = { street: 'Floriańska', building_number: '12', city: 'Kraków', post_code: '31-019' };
// The courier branch itself is covered in validate.courier.test.ts (with kurier enabled).

describe('validateDelivery', () => {
  it('accepts paczkomat with a target point', () => {
    const r = validateDelivery({ delivery_method: 'paczkomat', contact, target_point: 'KRA010' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.delivery.method).toBe('paczkomat');
      expect(r.delivery.target_point).toBe('KRA010');
    }
  });

  it('rejects paczkomat without a target point', () => {
    const r = validateDelivery({ delivery_method: 'paczkomat', contact });
    expect(r).toEqual({ ok: false, reason: 'missing_target_point' });
  });

  it('refuses courier delivery (kurier) while it is switched off', () => {
    expect(COURIER_ENABLED).toBe(false);
    expect(validateDelivery({ delivery_method: 'kurier', contact, address })).toEqual({ ok: false, reason: 'invalid_method' });
  });

  it('refuses studio pickup (odbior) while it is switched off', () => {
    expect(STUDIO_PICKUP_ENABLED).toBe(false);
    expect(CHECKOUT_DELIVERY_METHODS).toEqual(['paczkomat']);
    const r = validateDelivery({
      delivery_method: 'odbior',
      contact: { first_name: 'Anna', last_name: 'Kowalska', email: 'a@example.com' },
    });
    expect(r).toEqual({ ok: false, reason: 'invalid_method' });
  });

  it('requires phone for InPost (non-odbior) methods', () => {
    const noPhone = { first_name: 'Anna', last_name: 'Kowalska', email: 'a@example.com' };
    expect(validateDelivery({ delivery_method: 'paczkomat', contact: noPhone, target_point: 'KRA010' }))
      .toEqual({ ok: false, reason: 'invalid_contact' });
  });

  it('rejects an unknown method', () => {
    expect(validateDelivery({ delivery_method: 'drone', contact }))
      .toEqual({ ok: false, reason: 'invalid_method' });
  });

  it('rejects missing contact name/email', () => {
    expect(validateDelivery({ delivery_method: 'paczkomat', contact: { first_name: 'Anna' }, target_point: 'KRA010' }))
      .toEqual({ ok: false, reason: 'invalid_contact' });
  });

  it('rejects a non-object body', () => {
    expect(validateDelivery(null)).toEqual({ ok: false, reason: 'invalid_method' });
  });
});

describe('validateDelivery — destination country', () => {
  const both = ['PL', 'ES'] as const;

  it('reads a body without delivery_country as Poland (a cart page from before country selection)', () => {
    const r = validateDelivery({ delivery_method: 'paczkomat', contact, target_point: 'KRA010' }, { countries: ['PL'] });
    expect(r).toMatchObject({ ok: true, delivery: { country: 'PL', target_point: 'KRA010' } });
  });

  it('refuses a country checkout does not offer', () => {
    expect(
      validateDelivery({ delivery_method: 'paczkomat', contact, delivery_country: 'ES', service_point_id: '10544' }, { countries: ['PL'] }),
    ).toEqual({ ok: false, reason: 'invalid_country' });
    expect(
      validateDelivery({ delivery_method: 'paczkomat', contact, delivery_country: 'GB', target_point: 'X' }, { countries: both }),
    ).toEqual({ ok: false, reason: 'invalid_country' });
    expect(
      validateDelivery({ delivery_method: 'paczkomat', contact, delivery_country: 'es', service_point_id: '1' }, { countries: both }),
    ).toEqual({ ok: false, reason: 'invalid_country' });
  });

  it('takes a Sendcloud service point id for a Sendcloud country, never an InPost Poland code', () => {
    expect(
      validateDelivery({ delivery_method: 'paczkomat', contact, delivery_country: 'ES', service_point_id: '10544' }, { countries: both }),
    ).toEqual({
      ok: true,
      delivery: { method: 'paczkomat', contact, country: 'ES', service_point_id: '10544' },
    });
    expect(
      validateDelivery({ delivery_method: 'paczkomat', contact, delivery_country: 'ES', service_point_id: 10544 }, { countries: both }),
    ).toMatchObject({ ok: true, delivery: { service_point_id: '10544' } });
    expect(
      validateDelivery({ delivery_method: 'paczkomat', contact, delivery_country: 'ES', target_point: 'KRA010' }, { countries: both }),
    ).toEqual({ ok: false, reason: 'missing_target_point' });
  });

  it.each(['', 'abc', '0', '-1', '1.5', '12345678901234567'])('rejects the malformed service point id %j', (id) => {
    expect(
      validateDelivery({ delivery_method: 'paczkomat', contact, delivery_country: 'ES', service_point_id: id }, { countries: both }),
    ).toEqual({ ok: false, reason: 'missing_target_point' });
  });

  it('keeps Poland on its Paczkomat code', () => {
    const r = validateDelivery({ delivery_method: 'paczkomat', contact, delivery_country: 'PL', target_point: 'KRA010', service_point_id: '1' }, { countries: both });
    expect(r).toEqual({ ok: true, delivery: { method: 'paczkomat', contact, country: 'PL', target_point: 'KRA010' } });
  });
});

describe('needsShipment', () => {
  it('is true for InPost methods, false for pickup', () => {
    expect(needsShipment('paczkomat')).toBe(true);
    expect(needsShipment('kurier')).toBe(true);
    expect(needsShipment('odbior')).toBe(false);
  });
});
