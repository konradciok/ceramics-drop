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
