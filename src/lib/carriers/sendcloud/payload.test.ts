import { describe, it, expect } from 'vitest';
import { buildAnnounceRequest, sendcloudReference } from './payload';
import { SendcloudConfigError } from './errors';
import type { OrderForShipment } from '@/lib/carriers/types';

const order: OrderForShipment = {
  id: '0b6f7c1e-1111-4222-8333-444455556666',
  delivery_method: 'paczkomat',
  email: 'ana@example.com',
  receiver_first_name: 'Ana',
  receiver_last_name: 'García',
  receiver_phone: '+34600111222',
  inpost_target_point: 'ES009299',
  shipping_address: null,
  inpost_shipment_id: null,
  inpost_dispatch_order_id: null,
  shipping_channel: 'sendcloud',
  delivery_country: 'es',
  delivery_point: {
    id: '10544',
    code: 'ES009299',
    name: 'Locker Mercado',
    street: 'Calle Mayor',
    house_number: '5',
    post_code: '28013',
    city: 'Madrid',
    country: 'ES',
  },
  shipment_attempt: 0,
};

const opts = {
  senderAddressId: 321,
  shippingOptionCode: 'inpost_es:locker',
  parcel: { weightKg: 1.25, lengthCm: 64, widthCm: 38, heightCm: 19 },
};

describe('sendcloudReference', () => {
  it('is orders.id:<attempt>, attempt 0 when unset', () => {
    expect(sendcloudReference({ id: 'o1', shipment_attempt: 2 })).toBe('o1:2');
    expect(sendcloudReference({ id: 'o1', shipment_attempt: null })).toBe('o1:0');
  });
});

describe('buildAnnounceRequest', () => {
  it('addresses the chosen point and carries both references', () => {
    const body = buildAnnounceRequest(order, opts);
    expect(body.from_address).toEqual({ sender_address_id: 321 });
    expect(body.to_service_point).toEqual({ id: '10544' });
    expect(body.to_address).toEqual({
      name: 'Ana García',
      address_line_1: 'Calle Mayor',
      house_number: '5',
      postal_code: '28013',
      city: 'Madrid',
      country_code: 'ES',
      email: 'ana@example.com',
      phone_number: '+34600111222',
    });
    expect(body.ship_with).toEqual({ type: 'shipping_option_code', properties: { shipping_option_code: 'inpost_es:locker' } });
    expect(body.order_number).toBe(order.id);
    expect(body.external_reference_id).toBe(`${order.id}:0`);
    expect(body.parcels).toEqual([
      {
        weight: { value: '1.250', unit: 'kg' },
        dimensions: { length: '64.00', width: '38.00', height: '19.00', unit: 'cm' },
      },
    ]);
  });

  it('advances the reference with the attempt', () => {
    expect(buildAnnounceRequest({ ...order, shipment_attempt: 3 }, opts).external_reference_id).toBe(`${order.id}:3`);
  });

  it('throws for an incomplete receiver', () => {
    expect(() => buildAnnounceRequest({ ...order, receiver_phone: '  ' }, opts)).toThrow(/incomplete receiver/);
  });

  it('fails closed without a complete pickup point', () => {
    expect(() => buildAnnounceRequest({ ...order, delivery_point: null }, opts)).toThrow(SendcloudConfigError);
    expect(() =>
      buildAnnounceRequest({ ...order, delivery_point: { ...order.delivery_point!, city: null } }, opts),
    ).toThrow(/missing_delivery_point/);
  });
});
