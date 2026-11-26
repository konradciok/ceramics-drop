import { describe, it, expect, vi } from 'vitest';

// Courier delivery is switched off at checkout (COURIER_ENABLED); this file
// keeps its validation branch covered for when it comes back.
vi.mock('@/lib/pricing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pricing')>()),
  CHECKOUT_DELIVERY_METHODS: ['paczkomat', 'kurier'],
}));

import { validateDelivery } from './validate';

const contact = { first_name: 'Anna', last_name: 'Kowalska', email: 'a@example.com', phone: '+48600100200' };
const address = { street: 'Floriańska', building_number: '12', city: 'Kraków', post_code: '31-019' };

describe('validateDelivery — courier enabled', () => {
  it('accepts kurier with a full address and defaults country to PL', () => {
    const r = validateDelivery({ delivery_method: 'kurier', contact, address });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.delivery.method).toBe('kurier');
      expect(r.delivery.address?.country_code).toBe('PL');
      expect(r.delivery.address?.city).toBe('Kraków');
    }
  });

  it('stores the postcode in its canonical 00-000 form', () => {
    const r = validateDelivery({ delivery_method: 'kurier', contact, address: { ...address, post_code: '31019' } });
    expect(r.ok && r.delivery.address?.post_code).toBe('31-019');
  });

  it('rejects kurier with a postcode that is not Polish', () => {
    const r = validateDelivery({ delivery_method: 'kurier', contact, address: { ...address, post_code: '2801' } });
    expect(r).toEqual({ ok: false, reason: 'invalid_address' });
  });

  it('rejects kurier with an incomplete address', () => {
    const r = validateDelivery({ delivery_method: 'kurier', contact, address: { city: 'Kraków' } });
    expect(r).toEqual({ ok: false, reason: 'invalid_address' });
  });
});
