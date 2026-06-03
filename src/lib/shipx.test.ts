import { describe, it, expect } from 'vitest';
import {
  validateDelivery,
  buildShipmentPayload,
  needsShipment,
  parseShipxWebhook,
  SHIPX_SERVICE,
  type OrderForShipment,
} from './shipx';

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

  it('accepts odbior without phone, address, or target point', () => {
    const r = validateDelivery({
      delivery_method: 'odbior',
      contact: { first_name: 'Anna', last_name: 'Kowalska', email: 'a@example.com' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.delivery.method).toBe('odbior');
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
    expect(validateDelivery({ delivery_method: 'odbior', contact: { first_name: 'Anna' } }))
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

const baseOrder: OrderForShipment = {
  id: 'ord-1',
  delivery_method: 'paczkomat',
  email: 'a@example.com',
  receiver_first_name: 'Anna',
  receiver_last_name: 'Kowalska',
  receiver_phone: '+48600100200',
  inpost_target_point: 'KRA010',
  shipping_address: null,
  inpost_shipment_id: null,
};

describe('buildShipmentPayload', () => {
  it('builds a locker shipment with target_point and locker service', () => {
    const p = buildShipmentPayload(baseOrder);
    expect(p.service).toBe(SHIPX_SERVICE.paczkomat);
    expect(p.custom_attributes.target_point).toBe('KRA010');
    expect(p.custom_attributes.sending_method).toBe('parcel_locker');
    expect(p.reference).toBe('ord-1');
    expect(p.receiver.address).toBeUndefined();
    expect(p.receiver.phone).toBe('+48600100200');
  });

  it('builds a courier shipment with the receiver address and courier service', () => {
    const p = buildShipmentPayload({
      ...baseOrder,
      delivery_method: 'kurier',
      inpost_target_point: null,
      shipping_address: { ...address, country_code: 'PL' },
    });
    expect(p.service).toBe(SHIPX_SERVICE.kurier);
    expect(p.custom_attributes.sending_method).toBe('dispatch_order');
    expect(p.custom_attributes.target_point).toBeUndefined();
    expect(p.receiver.address?.city).toBe('Kraków');
  });

  it('throws for odbior (no shipment)', () => {
    expect(() => buildShipmentPayload({ ...baseOrder, delivery_method: 'odbior' })).toThrow();
  });
});

describe('parseShipxWebhook', () => {
  it('parses a top-level payload', () => {
    expect(parseShipxWebhook({ shipment_id: 42, status: 'confirmed', tracking_number: '620' }))
      .toEqual({ shipmentId: '42', status: 'confirmed', trackingNumber: '620' });
  });

  it('parses a nested payload', () => {
    expect(parseShipxWebhook({ event: 'x', payload: { id: 7, status: 'delivered' } }))
      .toEqual({ shipmentId: '7', status: 'delivered', trackingNumber: null });
  });

  it('returns null when shipment id or status is missing', () => {
    expect(parseShipxWebhook({ status: 'confirmed' })).toBeNull();
    expect(parseShipxWebhook({ shipment_id: 1 })).toBeNull();
    expect(parseShipxWebhook(null)).toBeNull();
  });
});
