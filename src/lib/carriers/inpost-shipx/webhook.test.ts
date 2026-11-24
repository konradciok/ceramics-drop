import { describe, it, expect } from 'vitest';
import { parseShipxWebhook } from './webhook';

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

  it('parses shipment_confirmed event (no status field) as confirmed', () => {
    expect(
      parseShipxWebhook({
        event: 'shipment_confirmed',
        payload: { shipment_id: 42, tracking_number: '620' },
      }),
    ).toEqual({ shipmentId: '42', status: 'confirmed', trackingNumber: '620' });
  });

  it('parses a flat shipment_confirmed shape with no nested payload', () => {
    expect(
      parseShipxWebhook({ event: 'shipment_confirmed', shipment_id: 42, tracking_number: '620' }),
    ).toEqual({ shipmentId: '42', status: 'confirmed', trackingNumber: '620' });
  });
});
