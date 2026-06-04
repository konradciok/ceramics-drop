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
 * Configuration / contract errors that will not succeed on Stripe webhook retry.
 * The sale is already committed — return 200 and surface the failure in logs/Sentry.
 */
export function isNonRetryableShipxError(err: unknown): boolean {
  if (err instanceof ShipxApiError) {
    return err.code === 'missing_trucker_id';
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('missing_trucker_id') || msg.includes('trucker_ID_is_not_set_for_organization');
}

/** Whether kurier checkout + courier ShipX calls are allowed (Web Trucker configured). */
export function isInpostCourierEnabled(raw: string | undefined): boolean {
  return raw?.trim() === 'true';
}

/** Stripe webhook: rethrow only when a retry might succeed (transient / unknown errors). */
export function shouldRethrowShipmentError(err: unknown): boolean {
  return !isNonRetryableShipxError(err);
}
