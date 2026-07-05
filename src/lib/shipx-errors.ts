/** Parsed ShipX API error body (400 responses). */
export type ShipxErrorBody = {
  status?: number;
  error?: string;
  message?: string;
};

/** ShipX HTTP failure with a parsed `error` code when the body is JSON. */
export class ShipxApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly shipxMessage: string | null;

  constructor(method: string, path: string, status: number, bodyText: string) {
    let code: string | null = null;
    let shipxMessage: string | null = null;
    try {
      const body = JSON.parse(bodyText) as ShipxErrorBody;
      code = typeof body.error === 'string' ? body.error : null;
      shipxMessage = typeof body.message === 'string' ? body.message : null;
    } catch {
      // body was not JSON — leave code null
    }
    const detail = code ?? (bodyText.slice(0, 120) || String(status));
    super(`ShipX ${method} ${path} → ${status}: ${detail}`);
    this.name = 'ShipxApiError';
    this.status = status;
    this.code = code;
    this.shipxMessage = shipxMessage;
  }
}

/**
 * Errors that cannot be fixed by retrying the webhook; the reconcile script
 * handles them out of band. The sale is already committed — callers should
 * return 200 to Stripe and surface the failure as a high-severity alert.
 *
 * - `missing_trucker_id` — InPost organisation does not have courier dispatch
 *   enabled. Fix: configure the organisation in Manager Paczek.
 * - `offer_expired` / `offer_unavailable` / `offer_not_found` — the buy offer
 *   is no longer valid; retrying the webhook will never succeed. The reconcile
 *   script re-creates the shipment and buys a fresh offer.
 */
const NON_RETRYABLE_CODES = new Set([
  'missing_trucker_id',
  'offer_expired',
  'offer_unavailable',
  'offer_not_found',
]);

export function isNonRetryableShipxError(err: unknown): boolean {
  if (err instanceof ShipxApiError && err.code !== null) {
    return NON_RETRYABLE_CODES.has(err.code);
  }
  // Also reached for a ShipxApiError with an unparsed code (non-JSON body) —
  // match on message text so a malformed body doesn't default to retryable.
  const msg =
    err instanceof ShipxApiError
      ? `${err.message} ${err.shipxMessage ?? ''}`
      : err instanceof Error
        ? err.message
        : String(err);
  return (
    msg.includes('missing_trucker_id') ||
    msg.includes('trucker_ID_is_not_set_for_organization') ||
    msg.includes('offer_expired') ||
    msg.includes('offer_unavailable') ||
    msg.includes('offer_not_found')
  );
}

/** Stripe webhook: rethrow only when a retry might succeed (transient / unknown errors). */
export function shouldRethrowShipmentError(err: unknown): boolean {
  return !isNonRetryableShipxError(err);
}
