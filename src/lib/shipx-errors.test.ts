import { describe, it, expect } from 'vitest';
import {
  ShipxApiError,
  isNonRetryableShipxError,
  isInpostCourierEnabled,
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
});

describe('isInpostCourierEnabled', () => {
  it('is true only when env is exactly "true"', () => {
    expect(isInpostCourierEnabled('true')).toBe(true);
    expect(isInpostCourierEnabled(' false')).toBe(false);
    expect(isInpostCourierEnabled(undefined)).toBe(false);
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
});
