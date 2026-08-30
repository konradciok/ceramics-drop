import { describe, it, expect } from 'vitest';
import {
  attemptIdentityKey,
  checkoutPreBodyError,
  shouldKeepAttemptIdOnCatch,
  CHECKOUT_KEEP_ATTEMPT_STATUSES,
} from './checkout-client';

describe('attemptIdentityKey (promo hard gate)', () => {
  // The Stripe idempotency key `pi_create_<orderId>` is amount-sensitive and
  // claim_promo_redemption rejects a reused order id carrying a DIFFERENT
  // promo — so applying, removing, or changing a code MUST change the attempt
  // identity (which regenerates attemptId), exactly like a cart change does.
  it('changes when a promo is applied, removed, or swapped', () => {
    const bare = attemptIdentityKey('k01|k02', null);
    const withPromo = attemptIdentityKey('k01|k02', 'WELCOME10');
    const withOther = attemptIdentityKey('k01|k02', 'ART10');
    expect(withPromo).not.toBe(bare);
    expect(withOther).not.toBe(withPromo);
  });

  it('is stable for the same cart + same code', () => {
    expect(attemptIdentityKey('k01', 'WELCOME10')).toBe(attemptIdentityKey('k01', 'WELCOME10'));
    expect(attemptIdentityKey('k01', null)).toBe(attemptIdentityKey('k01', null));
  });

  it('still changes when the cart changes', () => {
    expect(attemptIdentityKey('k01', 'WELCOME10')).not.toBe(attemptIdentityKey('k02', 'WELCOME10'));
  });

  it('a promo code cannot collide with a cart-only identity (delimiter is unambiguous)', () => {
    // A cart key never contains the reserved delimiter, so no (cartKey, promo)
    // pair can alias a different pair's identity.
    expect(attemptIdentityKey('k01', 'X')).not.toBe(attemptIdentityKey('k01|promo:X', null));
  });
});

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
