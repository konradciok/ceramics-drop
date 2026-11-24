import { describe, it, expect } from 'vitest';
import {
  mapSendcloudStatus,
  shouldAdvanceStatus,
  isLabelReadyOrLater,
  isFinalStatus,
} from './status-map';

describe('mapSendcloudStatus', () => {
  it('maps v3 codes, webhook messages and ids onto the ShipX vocabulary', () => {
    expect(mapSendcloudStatus({ code: 'READY_TO_SEND', message: 'Ready to send' })).toBe('confirmed');
    expect(mapSendcloudStatus({ id: 1000, message: 'Ready to send' })).toBe('confirmed');
    expect(mapSendcloudStatus({ message: 'En route to sorting center' })).toBe('taken_by_courier');
    expect(mapSendcloudStatus({ message: '  Awaiting customer PICKUP ' })).toBe('ready_to_pickup');
    expect(mapSendcloudStatus({ code: 'DELIVERED' })).toBe('delivered');
    expect(mapSendcloudStatus({ message: 'Shipment collected by customer' })).toBe('delivered');
    expect(mapSendcloudStatus({ id: 2000 })).toBe('canceled');
    expect(mapSendcloudStatus({ message: 'Returned to sender' })).toBe('returned_to_sender');
  });

  it('prefers code and message over the id', () => {
    expect(mapSendcloudStatus({ id: 11, message: 'Awaiting customer pickup' })).toBe('ready_to_pickup');
  });

  it('returns null for unknown or empty statuses', () => {
    expect(mapSendcloudStatus({ id: 424242, message: 'Something new' })).toBeNull();
    expect(mapSendcloudStatus({ message: 'Cancellation requested' })).toBeNull();
    expect(mapSendcloudStatus(null)).toBeNull();
    expect(mapSendcloudStatus({})).toBeNull();
  });
});

describe('shouldAdvanceStatus', () => {
  it('moves forward only', () => {
    expect(shouldAdvanceStatus(null, 'confirmed')).toBe(true);
    expect(shouldAdvanceStatus('confirmed', 'taken_by_courier')).toBe(true);
    expect(shouldAdvanceStatus('ready_to_pickup', 'taken_by_courier')).toBe(false);
    expect(shouldAdvanceStatus('confirmed', 'confirmed')).toBe(false);
  });

  it('never leaves a final status', () => {
    expect(shouldAdvanceStatus('delivered', 'returned_to_sender')).toBe(false);
    expect(shouldAdvanceStatus('canceled', 'confirmed')).toBe(false);
    expect(shouldAdvanceStatus('ready_to_pickup', 'returned_to_sender')).toBe(true);
  });

  it('advances from a status it does not rank (e.g. a ShipX one)', () => {
    expect(shouldAdvanceStatus('offers_prepared', 'confirmed')).toBe(true);
  });
});

describe('status helpers', () => {
  it('isLabelReadyOrLater excludes created and lost parcels', () => {
    expect(isLabelReadyOrLater('confirmed')).toBe(true);
    expect(isLabelReadyOrLater('delivered')).toBe(true);
    expect(isLabelReadyOrLater('created')).toBe(false);
    expect(isLabelReadyOrLater('canceled')).toBe(false);
    expect(isLabelReadyOrLater('returned_to_sender')).toBe(false);
    expect(isLabelReadyOrLater(null)).toBe(false);
  });

  it('isFinalStatus', () => {
    expect(isFinalStatus('delivered')).toBe(true);
    expect(isFinalStatus('canceled')).toBe(true);
    expect(isFinalStatus('ready_to_pickup')).toBe(false);
    expect(isFinalStatus(null)).toBe(false);
  });
});
