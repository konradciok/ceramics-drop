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
 * Organisation-level setup errors that cannot be fixed by retrying the webhook.
 * The sale is already committed — callers should return 200 to Stripe and surface
 * the failure as a high-severity alert so the InPost account can be corrected.
 *
 * `missing_trucker_id` means the InPost organisation does not have the courier
 * dispatch feature enabled. Fix: configure the organisation in Manager Paczek so
 * that `POST /v1/organizations/{id}/dispatch_orders` stops returning this code.
 */
export function isNonRetryableShipxError(err: unknown): boolean {
  if (err instanceof ShipxApiError) {
    return err.code === 'missing_trucker_id';
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('missing_trucker_id') || msg.includes('trucker_ID_is_not_set_for_organization');
}

/** Stripe webhook: rethrow only when a retry might succeed (transient / unknown errors). */
export function shouldRethrowShipmentError(err: unknown): boolean {
  return !isNonRetryableShipxError(err);
}
