import { describe, it, expect, vi } from 'vitest';
import { sendcloudCarrier, toCarrierShipment } from './carrier';
import { SendcloudConfigError } from './errors';
import type { SendcloudClient } from './client';
import type { OrderForShipment } from '@/lib/carriers/types';
import { isRetryableShipmentError } from '@/lib/carriers/errors';
import { SendcloudApiError } from './errors';

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
  delivery_country: 'ES',
  delivery_point: { id: '10544', street: 'Calle Mayor', post_code: '28013', city: 'Madrid', country: 'ES' },
  shipment_attempt: 1,
};

const announced = {
  id: 'shp-1',
  parcels: [
    {
      id: 77,
      status: { code: 'READY_TO_SEND', message: 'Ready to send' },
      tracking_number: 'ESTRK1',
      tracking_url: 'https://tracking.sendcloud.sc/forward?code=ESTRK1',
    },
  ],
};

function client(overrides: Partial<SendcloudClient> = {}): SendcloudClient {
  return {
    announceShipment: vi.fn().mockResolvedValue({ shipment: announced, existing: false }),
    getShipment: vi.fn().mockResolvedValue(announced),
    getParcelLabelPdf: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    cancelShipment: vi.fn().mockResolvedValue(undefined),
    getServicePoint: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const parcel = { weightKg: 1, lengthCm: 64, widthCm: 38, heightCm: 19 };

describe('toCarrierShipment', () => {
  it('reads id, tracking, mapped status and an https tracking URL', () => {
    expect(toCarrierShipment(announced)).toEqual({
      id: 'shp-1',
      trackingNumber: 'ESTRK1',
      status: 'confirmed',
      trackingUrl: 'https://tracking.sendcloud.sc/forward?code=ESTRK1',
    });
  });

  it('defaults an unknown status to created and drops a non-https URL', () => {
    expect(
      toCarrierShipment({ id: 'x', parcels: [{ id: 1, status: { message: 'Being announced' }, tracking_url: 'javascript:alert(1)' }] }),
    ).toEqual({ id: 'x', trackingNumber: null, status: 'created', trackingUrl: null });
  });
});

describe('sendcloudCarrier', () => {
  it('announces with the lane option, sender and packed parcel', async () => {
    const c = client();
    const parcelFor = vi.fn().mockResolvedValue(parcel);
    const carrier = sendcloudCarrier({ client: c, senderAddressId: 9, parcelFor, shippingOptionFor: () => 'inpost_es:locker' });

    const shipment = await carrier.create(order, { adoptExisting: true });

    expect(carrier.channel).toBe('sendcloud');
    expect(parcelFor).toHaveBeenCalledWith(order.id);
    const body = vi.mocked(c.announceShipment).mock.calls[0][0];
    expect(body.ship_with.properties.shipping_option_code).toBe('inpost_es:locker');
    expect(body.from_address).toEqual({ sender_address_id: 9 });
    expect(body.external_reference_id).toBe(`${order.id}:1`);
    expect(shipment).toEqual({ id: 'shp-1', trackingNumber: 'ESTRK1', status: 'confirmed', trackingUrl: announced.parcels[0].tracking_url });
  });

  it('fails closed (non-retryable) for a lane without a verified shipping option', async () => {
    const c = client();
    const carrier = sendcloudCarrier({ client: c, senderAddressId: 9, parcelFor: vi.fn() });
    // Austria: no Sendcloud option from Spain (the registry keeps it null).
    const err = await carrier.create({ ...order, delivery_country: 'AT' }, { adoptExisting: true }).catch((e) => e);

    expect(err).toBeInstanceOf(SendcloudConfigError);
    expect(err.code).toBe('no_shipping_option');
    expect(isRetryableShipmentError(err)).toBe(false);
    expect(c.announceShipment).not.toHaveBeenCalled();
  });

  it('reads the label of the first parcel and cancels by shipment id', async () => {
    const c = client();
    const carrier = sendcloudCarrier({ client: c, senderAddressId: 9, parcelFor: vi.fn() });

    await carrier.getLabelPdf('shp-1');
    await carrier.cancel!('shp-1');

    expect(c.getShipment).toHaveBeenCalledWith('shp-1');
    expect(c.getParcelLabelPdf).toHaveBeenCalledWith('77');
    expect(c.cancelShipment).toHaveBeenCalledWith('shp-1');
  });

  it('treats a repeat cancel of an already-cancelled shipment as done', async () => {
    const refused = new SendcloudApiError('POST', '/shipments/shp-1/cancel', 409, '{"errors":[{"code":"conflict"}]}');
    for (const status of [{ id: 2000, message: 'Cancelled' }, { code: 'CANCELLATION_REQUESTED', message: 'Cancellation requested' }]) {
      const c = client({
        cancelShipment: vi.fn().mockRejectedValue(refused),
        getShipment: vi.fn().mockResolvedValue({ id: 'shp-1', parcels: [{ id: 77, status }] }),
      });
      await expect(sendcloudCarrier({ client: c, senderAddressId: 9, parcelFor: vi.fn() }).cancel!('shp-1')).resolves.toBeUndefined();
    }
  });

  it('still fails a cancel Sendcloud refuses for a live or delivered shipment, or on a server error', async () => {
    const refused = new SendcloudApiError('POST', '/shipments/shp-1/cancel', 409, '{}');
    const delivered = client({
      cancelShipment: vi.fn().mockRejectedValue(refused),
      getShipment: vi.fn().mockResolvedValue({ id: 'shp-1', parcels: [{ id: 77, status: { id: 11, message: 'Delivered' } }] }),
    });
    await expect(sendcloudCarrier({ client: delivered, senderAddressId: 9, parcelFor: vi.fn() }).cancel!('shp-1')).rejects.toBe(refused);

    const down = new SendcloudApiError('POST', '/shipments/shp-1/cancel', 503, '{}');
    const c = client({ cancelShipment: vi.fn().mockRejectedValue(down) });
    await expect(sendcloudCarrier({ client: c, senderAddressId: 9, parcelFor: vi.fn() }).cancel!('shp-1')).rejects.toBe(down);
    expect(c.getShipment).not.toHaveBeenCalled();
  });

  it('has nothing to complete', async () => {
    const c = client();
    const carrier = sendcloudCarrier({ client: c, senderAddressId: 9, parcelFor: vi.fn() });
    await carrier.complete(
      { orderId: order.id, deliveryMethod: 'paczkomat', shipmentId: 'shp-1', dispatchOrderId: null, deliveryStatus: null },
      {},
    );
    expect(c.getShipment).not.toHaveBeenCalled();
  });
});

describe('isRetryableShipmentError (Sendcloud)', () => {
  const apiError = (status: number) => new SendcloudApiError('POST', '/shipments/announce', status, '{}');

  it('retries throttling and server faults, not validation errors', () => {
    expect(isRetryableShipmentError(apiError(503))).toBe(true);
    expect(isRetryableShipmentError(apiError(429))).toBe(true);
    expect(isRetryableShipmentError(apiError(400))).toBe(false);
    expect(isRetryableShipmentError(apiError(401))).toBe(false);
    expect(isRetryableShipmentError(new SendcloudConfigError('not_configured', 'x'))).toBe(false);
  });

  it('keeps the ShipX and unknown-error classification', () => {
    expect(isRetryableShipmentError(new Error('ShipX … offer_expired'))).toBe(false);
    expect(isRetryableShipmentError(new Error('socket hang up'))).toBe(true);
  });
});
