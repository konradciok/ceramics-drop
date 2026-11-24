import { describe, it, expect } from 'vitest';
import { validateDelivery, needsShipment } from './validate';
import { CHECKOUT_DELIVERY_METHODS, STUDIO_PICKUP_ENABLED } from '@/lib/pricing';

const contact = { first_name: 'Anna', last_name: 'Kowalska', email: 'a@example.com', phone: '+48600100200' };
const address = { street: 'Floriańska', building_number: '12', city: 'Kraków', post_code: '31-019' };

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

  it('accepts kurier with a full address and defaults country to PL', () => {
    const r = validateDelivery({ delivery_method: 'kurier', contact, address });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.delivery.method).toBe('kurier');
      expect(r.delivery.address?.country_code).toBe('PL');
      expect(r.delivery.address?.city).toBe('Kraków');
    }
  });

  it('rejects kurier with an incomplete address', () => {
    const r = validateDelivery({ delivery_method: 'kurier', contact, address: { city: 'Kraków' } });
    expect(r).toEqual({ ok: false, reason: 'invalid_address' });
  });

  it('refuses studio pickup (odbior) while it is switched off', () => {
    expect(STUDIO_PICKUP_ENABLED).toBe(false);
    expect(CHECKOUT_DELIVERY_METHODS).toEqual(['paczkomat', 'kurier']);
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
    expect(validateDelivery({ delivery_method: 'kurier', contact: { first_name: 'Anna' } }))
      .toEqual({ ok: false, reason: 'invalid_contact' });
  });

  it('rejects a non-object body', () => {
    expect(validateDelivery(null)).toEqual({ ok: false, reason: 'invalid_method' });
  });
});

describe('needsShipment', () => {
  it('is true for InPost methods, false for pickup', () => {
    expect(needsShipment('paczkomat')).toBe(true);
    expect(needsShipment('kurier')).toBe(true);
    expect(needsShipment('odbior')).toBe(false);
  });
});
