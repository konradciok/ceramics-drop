import { describe, it, expect } from 'vitest';
import {
  validateDelivery,
  buildShipmentPayload,
  buildDispatchOrderPayload,
  buildReturnShipmentPayload,
  needsShipment,
  parseShipxWebhook,
  SHIPX_SERVICE,
  type OrderForShipment,
  type StudioReturnConfig,
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
  inpost_dispatch_order_id: null,
};

describe('buildShipmentPayload', () => {
  it('builds a locker shipment with target_point and locker service', () => {
    const p = buildShipmentPayload(baseOrder);
    expect(p.service).toBe(SHIPX_SERVICE.paczkomat);
    expect(p.custom_attributes.target_point).toBe('KRA010');
    expect(p.custom_attributes.sending_method).toBe('parcel_locker');
    expect(p.reference).toBe('ord-1');
    expect(p.receiver!.address).toBeUndefined();
    expect(p.receiver!.phone).toBe('+48600100200');
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
    expect(p.receiver!.address?.city).toBe('Kraków');
  });

  it('throws for odbior (no shipment)', () => {
    expect(() => buildShipmentPayload({ ...baseOrder, delivery_method: 'odbior' })).toThrow();
  });

  it('throws when the paczkomat target point is missing', () => {
    expect(() => buildShipmentPayload({ ...baseOrder, inpost_target_point: null })).toThrow(/target_point/);
  });

  it('throws when the courier address is missing', () => {
    expect(() =>
      buildShipmentPayload({ ...baseOrder, delivery_method: 'kurier', shipping_address: null }),
    ).toThrow(/address/);
  });

  it('throws when receiver contact is incomplete', () => {
    expect(() => buildShipmentPayload({ ...baseOrder, receiver_phone: null })).toThrow(/receiver/);
  });

  it('rejects whitespace-only persisted values', () => {
    expect(() => buildShipmentPayload({ ...baseOrder, inpost_target_point: '   ' })).toThrow(/target_point/);
    expect(() => buildShipmentPayload({ ...baseOrder, receiver_first_name: '   ' })).toThrow(/receiver/);
  });
});

describe('buildDispatchOrderPayload', () => {
  it('schedules pickup for the next calendar day at 18:00', () => {
    // 2026-06-04 10:00 UTC = 2026-06-04 12:00 Warsaw (CEST, UTC+2)
    const now = new Date('2026-06-04T10:00:00Z');
    const p = buildDispatchOrderPayload('42', now);
    expect(p.shipment_ids).toEqual(['42']);
    expect(p.deadline_time).toBe('2026-06-05 18:00');
    expect(p.name).toContain('2026-06-05');
  });

  it('crosses month boundaries correctly', () => {
    const now = new Date('2026-06-30T10:00:00Z');
    const p = buildDispatchOrderPayload('7', now);
    expect(p.deadline_time).toBe('2026-07-01 18:00');
  });
});

const studioConfig: StudioReturnConfig = {
  first_name: 'Anna Ciok',
  last_name: 'Studio',
  email: 'studio@ciok.art',
  phone: '+48600000001',
  address: { street: 'Floriańska', building_number: '12', city: 'Kraków', post_code: '31-019', country_code: 'PL' },
};

const returnOrder = {
  id: 'ord-1',
  email: 'a@example.com',
  receiver_first_name: 'Anna',
  receiver_last_name: 'Kowalska',
  receiver_phone: '+48111222333',
  locale: 'pl',
};

describe('buildReturnShipmentPayload', () => {
  const configWithPoint = { ...studioConfig, return_point: 'WAW20A' };

  it('builds a locker return with customer sender and studio receiver', () => {
    const p = buildReturnShipmentPayload(returnOrder, configWithPoint);
    expect(p.service).toBe(SHIPX_SERVICE.paczkomat);
    expect(p.custom_attributes).toEqual({ sending_method: 'parcel_locker', target_point: 'WAW20A' });
    expect(p.sender).toEqual({
      first_name: 'Anna',
      last_name: 'Kowalska',
      email: 'a@example.com',
      phone: '+48111222333',
    });
    expect(p.receiver).toMatchObject({
      first_name: 'Anna Ciok',
      last_name: 'Studio',
      address: studioConfig.address,
    });
    expect(p.reference).toBe('return:ord-1');
  });

  it('throws when return_point is missing', () => {
    expect(() => buildReturnShipmentPayload(returnOrder, studioConfig)).toThrow('return_point required');
  });

  it('throws when customer contact is incomplete', () => {
    expect(() =>
      buildReturnShipmentPayload(
        { ...returnOrder, receiver_phone: null },
        configWithPoint,
      ),
    ).toThrow('incomplete customer contact');
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
