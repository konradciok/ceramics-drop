import { describe, it, expect } from 'vitest';
import {
  ShipxApiError,
  isNonRetryableShipxError,
  shouldRethrowShipmentError,
} from './shipx-errors';

describe('ShipxApiError', () => {
  it('parses missing_trucker_id from JSON body', () => {
    const err = new ShipxApiError(
      'POST',
      '/v1/organizations/195780/shipments',
      400,
      JSON.stringify({
        status: 400,
        error: 'missing_trucker_id',
        message: 'trucker_ID_is_not_set_for_organization',
      }),
    );
    expect(err.code).toBe('missing_trucker_id');
    expect(isNonRetryableShipxError(err)).toBe(true);
  });
});

describe('isNonRetryableShipxError', () => {
  it('matches legacy Error message shape', () => {
    expect(
      isNonRetryableShipxError(
        new Error(
          'ShipX POST /v1/organizations/195780/shipments → 400: {"error":"missing_trucker_id"}',
        ),
      ),
    ).toBe(true);
  });

  it('does not treat generic 500 as non-retryable', () => {
    expect(isNonRetryableShipxError(new Error('ShipX POST /shipments → 500: upstream'))).toBe(false);
  });

  it('treats offer_expired ShipxApiError as non-retryable', () => {
    const err = new ShipxApiError(
      'POST',
      '/v1/shipments/123/buy',
      422,
      JSON.stringify({ error: 'offer_expired', message: 'The offer has expired' }),
    );
    expect(isNonRetryableShipxError(err)).toBe(true);
  });

  it('treats offer_unavailable ShipxApiError as non-retryable', () => {
    const err = new ShipxApiError(
      'POST',
      '/v1/shipments/123/buy',
      422,
      JSON.stringify({ error: 'offer_unavailable', message: 'Offer unavailable' }),
    );
    expect(isNonRetryableShipxError(err)).toBe(true);
  });

  it('treats offer_not_found ShipxApiError as non-retryable', () => {
    const err = new ShipxApiError(
      'POST',
      '/v1/shipments/123/buy',
      404,
      JSON.stringify({ error: 'offer_not_found', message: 'Offer not found' }),
    );
    expect(isNonRetryableShipxError(err)).toBe(true);
  });

  it('treats Error message containing offer_expired as non-retryable', () => {
    expect(
      isNonRetryableShipxError(new Error('ShipX POST /v1/shipments/123/buy → 422: offer_expired')),
    ).toBe(true);
  });
});

describe('shouldRethrowShipmentError', () => {
  it('does not rethrow missing_trucker_id (production CERAMICS-DROP-2)', () => {
    const err = new ShipxApiError(
      'POST',
      '/v1/organizations/195780/shipments',
      400,
      JSON.stringify({ error: 'missing_trucker_id', message: 'trucker_ID_is_not_set_for_organization' }),
    );
    expect(shouldRethrowShipmentError(err)).toBe(false);
  });

  it('rethrows transient ShipX failures so Stripe can retry', () => {
    expect(shouldRethrowShipmentError(new Error('ShipX POST /shipments → 503: upstream'))).toBe(true);
  });

  it('does not rethrow offer_expired (reconcile script handles it)', () => {
    const err = new ShipxApiError(
      'POST',
      '/v1/shipments/123/buy',
      422,
      JSON.stringify({ error: 'offer_expired' }),
    );
    expect(shouldRethrowShipmentError(err)).toBe(false);
  });

  it('does not rethrow offer_unavailable', () => {
    const err = new ShipxApiError(
      'POST',
      '/v1/shipments/123/buy',
      422,
      JSON.stringify({ error: 'offer_unavailable' }),
    );
    expect(shouldRethrowShipmentError(err)).toBe(false);
  });

  it('does not rethrow offer_not_found', () => {
    const err = new ShipxApiError(
      'POST',
      '/v1/shipments/123/buy',
      404,
      JSON.stringify({ error: 'offer_not_found' }),
    );
    expect(shouldRethrowShipmentError(err)).toBe(false);
  });
});
