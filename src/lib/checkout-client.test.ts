import { describe, it, expect } from 'vitest';
import {
  checkoutPreBodyError,
  shouldKeepAttemptIdOnCatch,
  CHECKOUT_KEEP_ATTEMPT_STATUSES,
} from './checkout-client';

describe('checkoutPreBodyError', () => {
  it('maps 503 + print_asset_error to a keep-attemptId recovery path', () => {
    expect(checkoutPreBodyError(503, { error: 'print_asset_error' })).toEqual({
      errorKey: 'cart.printAssetError',
      analyticsReason: 'print_asset_error',
      analyticsStatus: 503,
    });
  });

  it('maps bare 503 (no body) to print_asset_error recovery', () => {
    expect(checkoutPreBodyError(503)).toEqual({
      errorKey: 'cart.printAssetError',
      analyticsReason: 'print_asset_error',
      analyticsStatus: 503,
    });
  });

  it('returns null for 503 with an unrelated error code', () => {
    expect(checkoutPreBodyError(503, { error: 'other' })).toBeNull();
  });

  it('maps 429 to rate-limited recovery', () => {
    expect(checkoutPreBodyError(429)).toEqual({
      errorKey: 'cart.rateLimited',
      analyticsReason: 'rate_limited',
      analyticsStatus: 429,
    });
  });

  it('returns null for unhandled statuses', () => {
    expect(checkoutPreBodyError(500)).toBeNull();
  });
});

describe('shouldKeepAttemptIdOnCatch', () => {
  it('keeps attemptId for pre-PI failure statuses', () => {
    for (const status of CHECKOUT_KEEP_ATTEMPT_STATUSES) {
      expect(shouldKeepAttemptIdOnCatch(status)).toBe(true);
    }
  });

  it('discards attemptId for generic failures', () => {
    expect(shouldKeepAttemptIdOnCatch(500)).toBe(false);
  });

  it('keeps attemptId when a 503 body parse throws after the response arrived', () => {
    expect(shouldKeepAttemptIdOnCatch(503)).toBe(true);
  });
});
