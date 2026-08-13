import { describe, it, expect } from 'vitest';
import { customerOrderStatus, type CustomerStatusInput } from './status';

function input(overrides: Partial<CustomerStatusInput> = {}): CustomerStatusInput {
  return {
    status: 'paid',
    fulfilmentType: 'inpost',
    deliveryMethod: 'paczkomat',
    deliveryStatus: null,
    inpostTrackingNumber: null,
    latestJobStatus: null,
    prodigiTracking: null,
    ...overrides,
  };
}

const PRINT = {
  fulfilmentType: 'prodigi',
  deliveryMethod: 'kurier',
  prodigiTracking: {
    carrier: 'DPD',
    trackingNumber: 'DPD123',
    trackingUrl: 'https://track.dpd.example/DPD123',
  },
} satisfies Partial<CustomerStatusInput>;

describe('customerOrderStatus — overrides', () => {
  it('refunded overrides everything, with no tracking', () => {
    expect(customerOrderStatus(input({ status: 'refunded', deliveryStatus: 'delivered', inpostTrackingNumber: '520' })))
      .toEqual({ status: 'refunded', tracking: null });
    expect(customerOrderStatus(input({ ...PRINT, status: 'refunded', latestJobStatus: 'shipped' })).status)
      .toBe('refunded');
  });

  it('studio pickup reads as awaiting pickup (both discriminators)', () => {
    expect(customerOrderStatus(input({ fulfilmentType: 'pickup', deliveryMethod: 'odbior' })).status)
      .toBe('awaitingPickup');
    // Legacy rows without fulfilment_type still resolve via delivery_method.
    expect(customerOrderStatus(input({ fulfilmentType: null, deliveryMethod: 'odbior' })).status)
      .toBe('awaitingPickup');
  });

  // M-5: a `failed` order can be a captured-then-refunded payment (the
  // private-sale double-paid path). It must never render as a normal delivery
  // state — the mapper stays total even though account queries exclude it.
  it('failed overrides delivery state: cancelled, no tracking (M-5 contract)', () => {
    expect(customerOrderStatus(input({ status: 'failed', deliveryStatus: 'delivered', inpostTrackingNumber: '520' })))
      .toEqual({ status: 'cancelled', tracking: null });
    expect(customerOrderStatus(input({ ...PRINT, status: 'failed', latestJobStatus: 'shipped' })))
      .toEqual({ status: 'cancelled', tracking: null });
    // Even a pickup order: failed is terminal, not "awaiting pickup".
    expect(customerOrderStatus(input({ status: 'failed', fulfilmentType: 'pickup', deliveryMethod: 'odbior' })).status)
      .toBe('cancelled');
  });
});

describe('customerOrderStatus — prints (fulfilment_jobs driven)', () => {
  it.each([
    [null, 'processing'],
    ['queued', 'processing'],
    ['fulfilment_submitting', 'processing'],
    ['fulfilment_submitted', 'processing'],
    ['failed_action_required', 'processing'],
    ['some_future_status', 'processing'],
    ['in_production', 'inProduction'],
    ['cancelled', 'cancelled'],
  ])('job %s → %s without tracking', (job, expected) => {
    const result = customerOrderStatus(input({ ...PRINT, latestJobStatus: job }));
    expect(result.status).toBe(expected);
    expect(result.tracking).toBeNull();
  });

  it.each(['shipped', 'completed'])('job %s → shipped with carrier tracking', (job) => {
    expect(customerOrderStatus(input({ ...PRINT, latestJobStatus: job }))).toEqual({
      status: 'shipped',
      tracking: { number: 'DPD123', carrier: 'DPD', url: 'https://track.dpd.example/DPD123' },
    });
  });

  it('renders a non-https tracking URL as null (link suppressed, number kept)', () => {
    const result = customerOrderStatus(
      input({
        ...PRINT,
        latestJobStatus: 'shipped',
        prodigiTracking: { carrier: 'DPD', trackingNumber: 'DPD123', trackingUrl: 'javascript:alert(1)' },
      }),
    );
    expect(result.tracking).toEqual({ number: 'DPD123', carrier: 'DPD', url: null });
  });

  it('shipped without a persisted tracking number shows status only', () => {
    const result = customerOrderStatus(input({ ...PRINT, latestJobStatus: 'shipped', prodigiTracking: null }));
    expect(result).toEqual({ status: 'shipped', tracking: null });
  });
});

describe('customerOrderStatus — ceramics (InPost delivery_status driven)', () => {
  it.each([
    [null, 'processing'],
    ['created', 'processing'],
    ['offer_selected', 'processing'],
    ['offers_prepared', 'processing'],
    ['confirmed', 'processing'],
  ])('pre-shipment status %s → processing', (status, expected) => {
    expect(customerOrderStatus(input({ deliveryStatus: status })).status).toBe(expected);
  });

  it.each(['dispatched_by_sender', 'collected_from_sender', 'out_for_delivery', 'adopted_at_sorting_center'])(
    'movement status %s with tracking → shipped + InPost link',
    (status) => {
      const result = customerOrderStatus(
        input({ deliveryStatus: status, inpostTrackingNumber: '520000123' }),
      );
      expect(result.status).toBe('shipped');
      expect(result.tracking).toEqual({
        number: '520000123',
        carrier: 'InPost',
        url: 'https://inpost.pl/sledzenie-przesylek?number=520000123',
      });
    },
  );

  it('unknown status without tracking stays processing (conservative)', () => {
    expect(customerOrderStatus(input({ deliveryStatus: 'weird_new_status' })))
      .toEqual({ status: 'processing', tracking: null });
  });

  it.each(['ready_to_pickup', 'pickup_reminder_sent'])('%s → readyForPickup', (status) => {
    const result = customerOrderStatus(
      input({ deliveryStatus: status, inpostTrackingNumber: '520000123' }),
    );
    expect(result.status).toBe('readyForPickup');
    expect(result.tracking?.number).toBe('520000123');
  });

  it('delivered → delivered, tracking link retained', () => {
    const result = customerOrderStatus(
      input({ deliveryStatus: 'delivered', inpostTrackingNumber: '520000123' }),
    );
    expect(result.status).toBe('delivered');
    expect(result.tracking?.url).toContain('inpost.pl');
  });

  it('pre-shipment with an early tracking number keeps processing but exposes the number', () => {
    const result = customerOrderStatus(
      input({ deliveryStatus: 'confirmed', inpostTrackingNumber: '520000123' }),
    );
    expect(result.status).toBe('processing');
    expect(result.tracking?.number).toBe('520000123');
  });

  it('normalizes delivery_status case/whitespace', () => {
    expect(customerOrderStatus(input({ deliveryStatus: ' Delivered ' })).status).toBe('delivered');
  });
});
