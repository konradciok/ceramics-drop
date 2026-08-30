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
  errorKey: 'cart.printAssetError' | 'cart.rateLimited';
  analyticsReason: 'print_asset_error' | 'rate_limited';
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
    if (body?.error && body.error !== 'print_asset_error') return null;
    return {
      errorKey: 'cart.printAssetError',
      analyticsReason: 'print_asset_error',
      analyticsStatus: 503,
    };
  }
  return null;
}
