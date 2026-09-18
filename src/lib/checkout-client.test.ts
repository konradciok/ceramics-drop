import { describe, it, expect } from 'vitest';
import {
  attemptIdentityKey,
  cartSummaryAmounts,
  checkoutPreBodyError,
  parseCheckoutAmounts,
  shouldKeepAttemptIdOnCatch,
  CHECKOUT_KEEP_ATTEMPT_STATUSES,
} from './checkout-client';

describe('cart summary vs. what Stripe will charge', () => {
  // The cart prices shipping from the CODE-default tables; /api/checkout prices
  // the PaymentIntent from the CMS-published bundle. A publish between page
  // load and payment moves one and not the other, so once the PaymentIntent
  // exists the server's figures have to win — otherwise the buyer reads one
  // total and is charged another, with nothing in the UI showing the real one.

  /** What the cart computed for itself: 90 zł of goods + the constant 30 zł kurier. */
  const ESTIMATE = { currency: 'pln', subtotal: 90, shipping: 30, discount: 0, total: 120 } as const;
  /** What checkout actually charged: the published 44 zł kurier rate. */
  const CONFIRMED = { currency: 'pln', subtotal: 9_000, shipping: 4_400, discount: 0, total: 13_400 } as const;

  it('shows the live estimate while there is nothing authoritative yet', () => {
    // Pre-PaymentIntent the estimate is a legitimate quote and must keep
    // tracking the buyer's delivery/promo/currency choices.
    expect(cartSummaryAmounts(ESTIMATE, null)).toEqual({ ...ESTIMATE, confirmed: false });
  });

  it('the SERVER figures win once the PaymentIntent exists — not the client-computed ones', () => {
    const summary = cartSummaryAmounts(ESTIMATE, CONFIRMED);
    expect(summary.shipping).toBe(44);
    expect(summary.total).toBe(134);
    // The values the cart would otherwise have gone on displaying.
    expect(summary.shipping).not.toBe(ESTIMATE.shipping);
    expect(summary.total).not.toBe(ESTIMATE.total);
    expect(summary.confirmed).toBe(true);
  });

  it('swaps the whole snapshot, so the displayed rows still reconcile', () => {
    // Swapping only shipping/total would leave a subtotal that no longer adds
    // up to the total printed under it.
    const summary = cartSummaryAmounts(
      { currency: 'pln', subtotal: 90, shipping: 30, discount: 10, total: 110 },
      { currency: 'pln', subtotal: 9_500, shipping: 4_400, discount: 1_000, total: 12_900 },
    );
    expect(summary.subtotal - summary.discount + summary.shipping).toBe(summary.total);
    expect(summary).toEqual({ currency: 'pln', subtotal: 95, shipping: 44, discount: 10, total: 129, confirmed: true });
  });

  it('carries the charged currency, so a mid-payment currency switch cannot relabel the amount', () => {
    // The header switcher stays live behind the mounted Stripe form.
    const summary = cartSummaryAmounts({ ...ESTIMATE, currency: 'gbp' }, CONFIRMED);
    expect(summary.currency).toBe('pln');
    expect(summary.total).toBe(134);
  });

  it('gives the gift-card panel the charged currency once confirmed, the live one before', () => {
    // GiftCardPayment formats the server-confirmed cash remainder — the amount
    // Stripe actually takes — so once that exists it must be labelled in the
    // charged currency, not whatever the switcher now says. Before
    // confirmation nothing is charged yet and the live currency is correct (it
    // is also what `giftCard.currency` is matched against on apply).
    // CartView derives exactly this pair: `confirmed ? currency : printCurrency`.
    const afterSwitch = cartSummaryAmounts({ ...ESTIMATE, currency: 'gbp' }, CONFIRMED);
    expect(afterSwitch.confirmed).toBe(true);
    expect(afterSwitch.currency).toBe('pln');

    const beforePayment = cartSummaryAmounts({ ...ESTIMATE, currency: 'gbp' }, null);
    expect(beforePayment.confirmed).toBe(false);
    expect(beforePayment.currency).toBe('gbp');
  });
});

describe('parseCheckoutAmounts', () => {
  const VALID = { currency: 'eur', subtotal: 4_200, shipping: 1_500, discount: 100, total: 5_600 };

  it('accepts a well-formed payload', () => {
    expect(parseCheckoutAmounts(VALID)).toEqual(VALID);
  });

  it('falls back to null rather than render a garbled or partial price', () => {
    // Each of these must leave the cart on its own estimate — no worse than
    // before the field existed, and never a blank/NaN price on a payment page.
    expect(parseCheckoutAmounts(undefined)).toBeNull();        // older deployment
    expect(parseCheckoutAmounts(null)).toBeNull();
    expect(parseCheckoutAmounts('13400')).toBeNull();
    expect(parseCheckoutAmounts({ ...VALID, total: undefined })).toBeNull();
    expect(parseCheckoutAmounts({ ...VALID, total: '5600' })).toBeNull();
    expect(parseCheckoutAmounts({ ...VALID, total: 56.5 })).toBeNull();   // minor units are integers
    expect(parseCheckoutAmounts({ ...VALID, shipping: -1 })).toBeNull();
    expect(parseCheckoutAmounts({ ...VALID, total: Number.NaN })).toBeNull();
    expect(parseCheckoutAmounts({ ...VALID, currency: 'usd' })).toBeNull(); // not a sellable currency
    expect(parseCheckoutAmounts({ ...VALID, currency: undefined })).toBeNull();
  });

  it('accepts a zero-shipping, zero-discount order (pickup, gift card)', () => {
    const free = { currency: 'pln', subtotal: 9_000, shipping: 0, discount: 0, total: 9_000 };
    expect(parseCheckoutAmounts(free)).toEqual(free);
  });
});

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

  it('maps 503 + print_pricing_unavailable to a keep-attemptId recovery path (not the generic print_asset_error copy)', () => {
    expect(checkoutPreBodyError(503, { error: 'print_pricing_unavailable' })).toEqual({
      errorKey: 'cart.printPricingUnavailable',
      analyticsReason: 'print_pricing_unavailable',
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
