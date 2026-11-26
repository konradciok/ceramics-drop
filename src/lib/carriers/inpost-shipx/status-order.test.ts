import { describe, it, expect } from 'vitest';
import { isFinalShipxStatus, isKnownShipxStatus, shouldAdvanceShipxStatus } from './status-order';

describe('shouldAdvanceShipxStatus', () => {
  it('accepts forward moves across stages', () => {
    expect(shouldAdvanceShipxStatus('created', 'confirmed')).toBe(true);
    expect(shouldAdvanceShipxStatus('confirmed', 'taken_by_courier')).toBe(true);
    expect(shouldAdvanceShipxStatus('taken_by_courier', 'ready_to_pickup')).toBe(true);
    expect(shouldAdvanceShipxStatus('ready_to_pickup', 'delivered')).toBe(true);
    expect(shouldAdvanceShipxStatus('confirmed', 'canceled')).toBe(true);
  });

  it('accepts lateral moves within a stage (keeps the latest detail)', () => {
    expect(shouldAdvanceShipxStatus('taken_by_courier', 'out_for_delivery')).toBe(true);
    expect(shouldAdvanceShipxStatus('ready_to_pickup', 'pickup_reminder_sent')).toBe(true);
  });

  it('rejects regressions and the same status', () => {
    expect(shouldAdvanceShipxStatus('delivered', 'created')).toBe(false);
    expect(shouldAdvanceShipxStatus('delivered', 'confirmed')).toBe(false);
    expect(shouldAdvanceShipxStatus('taken_by_courier', 'confirmed')).toBe(false);
    expect(shouldAdvanceShipxStatus('ready_to_pickup', 'out_for_delivery')).toBe(false);
    expect(shouldAdvanceShipxStatus('confirmed', 'confirmed')).toBe(false);
  });

  it('never moves off a final status', () => {
    expect(shouldAdvanceShipxStatus('delivered', 'returned_to_sender')).toBe(false);
    expect(shouldAdvanceShipxStatus('canceled', 'delivered')).toBe(false);
    expect(shouldAdvanceShipxStatus('returned_to_sender', 'canceled')).toBe(false);
  });

  it('rejects unknown statuses', () => {
    expect(shouldAdvanceShipxStatus('created', '<anything-at-all>')).toBe(false);
    expect(shouldAdvanceShipxStatus(null, 'in_transit')).toBe(false);
    expect(shouldAdvanceShipxStatus(null, 'toString')).toBe(false);
  });

  it('an empty or unrecognised stored status accepts any known status', () => {
    expect(shouldAdvanceShipxStatus(null, 'confirmed')).toBe(true);
    expect(shouldAdvanceShipxStatus('legacy_value', 'created')).toBe(true);
  });
});

describe('isKnownShipxStatus / isFinalShipxStatus', () => {
  it('classifies statuses', () => {
    expect(isKnownShipxStatus('confirmed')).toBe(true);
    expect(isKnownShipxStatus('constructor')).toBe(false);
    expect(isFinalShipxStatus('delivered')).toBe(true);
    expect(isFinalShipxStatus('canceled')).toBe(true);
    expect(isFinalShipxStatus('ready_to_pickup')).toBe(false);
    expect(isFinalShipxStatus(null)).toBe(false);
  });
});
