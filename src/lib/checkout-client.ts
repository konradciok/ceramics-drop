import { SELLABLE_CURRENCIES, type Currency } from './currency';

/**
 * The amounts POST /api/checkout actually priced the order from — minor units,
 * in the currency it charged. Returned under `amounts` on every success
 * response (see src/app/api/checkout/route.ts).
 *
 * Why this exists: the cart's own summary is computed from the CODE-default
 * rate tables, while checkout prices the charge from the CMS-published bundle
 * (`getShippingRatesForCheckout()`). A publish between page load and payment
 * moves one and not the other, so once the PaymentIntent exists the cart must
 * stop showing its own estimate and show these instead — the same principle
 * that already freezes the promo row once `clientSecret` is set.
 *
 * `currency` travels with the numbers deliberately: the buyer can still flip
 * the header currency switcher while the Stripe form is mounted, and a minor
 * amount rendered under the wrong symbol would be its own desync.
 */
export type CheckoutAmounts = {
  currency: Currency;
  /** Merchandise, pre-discount. */
  subtotal: number;
  shipping: number;
  discount: number;
  /**
   * The ORDER total: subtotal − discount + shipping. It is what the buyer
   * owes, which is what a cart summary renders — but it is NOT always what
   * Stripe charges. On a gift-card-funded order the PaymentIntent is created
   * for the cash remainder alone (`ensureBalanceIntent`,
   * src/server/gift-card-checkout.ts), with the card balance covering the
   * rest, so never label this figure "you will be charged X". That split
   * arrives on the same response as `cash_amount` / `gift_card_amount`, and
   * GiftCardPayment renders it.
   */
  total: number;
};

const AMOUNT_KEYS = ['subtotal', 'shipping', 'discount', 'total'] as const;

const isMinorAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Narrows an untrusted `amounts` payload. Returns null on anything malformed
 * or missing so the caller keeps its own estimate — a client talking to an
 * older deployment (no `amounts` field) is no worse off than before this
 * field existed, and a garbled payload can never be rendered as a price.
 */
export function parseCheckoutAmounts(value: unknown): CheckoutAmounts | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!(SELLABLE_CURRENCIES as readonly string[]).includes(raw.currency as string)) return null;
  if (!AMOUNT_KEYS.every((key) => isMinorAmount(raw[key]))) return null;
  return {
    currency: raw.currency as Currency,
    subtotal: raw.subtotal as number,
    shipping: raw.shipping as number,
    discount: raw.discount as number,
    total: raw.total as number,
  };
}

/** Cart-summary figures in MAJOR units, plus which side they came from. */
export type CartSummaryAmounts = {
  currency: Currency;
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  /** True once these are the server's charged figures, not a live estimate. */
  confirmed: boolean;
};

/**
 * Picks what the cart summary renders. Before the PaymentIntent exists there
 * is nothing authoritative to show, so the live client estimate wins — it is a
 * legitimate pre-payment quote. Once the server has confirmed amounts, THOSE
 * win unconditionally: they are what Stripe will charge, so the display can no
 * longer drift away from them (currency switch, rate republish, anything).
 *
 * Callers pass `confirmed` as null until `clientSecret` is set.
 */
export function cartSummaryAmounts(
  estimate: {
    currency: Currency;
    /** MAJOR units, as the cart computes them. */
    subtotal: number;
    shipping: number;
    discount: number;
    total: number;
  },
  confirmed: CheckoutAmounts | null,
): CartSummaryAmounts {
  if (!confirmed) return { ...estimate, confirmed: false };
  return {
    currency: confirmed.currency,
    subtotal: confirmed.subtotal / 100,
    shipping: confirmed.shipping / 100,
    discount: confirmed.discount / 100,
    total: confirmed.total / 100,
    confirmed: true,
  };
}

/**
 * Identity of one checkout attempt: cart contents + the applied promo code.
 * CartView regenerates `attemptId` whenever this key changes. The promo code
 * MUST participate (hard Phase 3 gate): the Stripe idempotency key
 * `pi_create_<orderId>` is amount-sensitive, and `claim_promo_redemption`
 * rejects a reused order id that carries a different promo — a stale
 * attemptId across a code change would surface as a Stripe 400 or a
 * misleading `promo_exhausted`. The `\n` delimiter cannot appear in a cart
 * key (ids are registry ids / `print:` tokens), so no (cartKey, promo) pair
 * can alias another.
 */
export function attemptIdentityKey(cartKey: string, promoCode: string | null): string {
  return promoCode ? `${cartKey}\npromo:${promoCode}` : cartKey;
}

/** HTTP statuses where checkout fails before reserve/PI — attemptId must survive retries. */
export const CHECKOUT_KEEP_ATTEMPT_STATUSES = new Set([409, 429, 503]);

export function shouldKeepAttemptIdOnCatch(status: number): boolean {
  return CHECKOUT_KEEP_ATTEMPT_STATUSES.has(status);
}

export type CheckoutPreBodyError = {
  errorKey: 'cart.printAssetError' | 'cart.printPricingUnavailable' | 'cart.rateLimited';
  analyticsReason: 'print_asset_error' | 'print_pricing_unavailable' | 'rate_limited';
  analyticsStatus: 429 | 503;
};

/**
 * Maps 429/503 checkout responses where the server rejected before any
 * reserve/Stripe work. Caller keeps attemptId and shows the returned error key.
 */
export function checkoutPreBodyError(
  status: number,
  body?: { error?: string },
): CheckoutPreBodyError | null {
  if (status === 429) {
    return {
      errorKey: 'cart.rateLimited',
      analyticsReason: 'rate_limited',
      analyticsStatus: 429,
    };
  }
  if (status === 503) {
    if (body?.error === 'print_pricing_unavailable') {
      return {
        errorKey: 'cart.printPricingUnavailable',
        analyticsReason: 'print_pricing_unavailable',
        analyticsStatus: 503,
      };
    }
    if (body?.error && body.error !== 'print_asset_error') return null;
    return {
      errorKey: 'cart.printAssetError',
      analyticsReason: 'print_asset_error',
      analyticsStatus: 503,
    };
  }
  return null;
}
