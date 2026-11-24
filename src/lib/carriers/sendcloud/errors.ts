/** Sendcloud API v3 failure (non-2xx other than the handled 409). */
export class SendcloudApiError extends Error {
  readonly status: number;
  /** First `errors[].code` of the JSON:API-style error body, when parseable. */
  readonly code: string | null;

  constructor(method: string, path: string, status: number, bodyText: string) {
    let code: string | null = null;
    let detail: string | null = null;
    try {
      const body = JSON.parse(bodyText) as { errors?: Array<{ code?: unknown; detail?: unknown }> };
      const first = body.errors?.[0];
      code = typeof first?.code === 'string' ? first.code : null;
      detail = typeof first?.detail === 'string' ? first.detail : null;
    } catch {
      // body was not JSON — leave code null
    }
    super(`Sendcloud ${method} ${path} → ${status}: ${detail ?? code ?? (bodyText.slice(0, 120) || String(status))}`);
    this.name = 'SendcloudApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * A Sendcloud shipment that cannot be created until a person fixes our side
 * (configuration or data) — retrying the payment webhook can never help.
 *
 * - `no_shipping_option` — the destination has no verified Sendcloud shipping
 *   option code in src/lib/delivery/destinations.ts.
 * - `missing_delivery_point` — the order has no chosen pickup point.
 * - `manual_packing_required` — the order needs more than one box (a point
 *   shipment carries exactly one parcel) or has nothing to pack.
 * - `not_configured` — SENDCLOUD_* env missing.
 */
export type SendcloudConfigErrorCode =
  | 'no_shipping_option'
  | 'missing_delivery_point'
  | 'manual_packing_required'
  | 'not_configured';

export class SendcloudConfigError extends Error {
  readonly code: SendcloudConfigErrorCode;

  constructor(code: SendcloudConfigErrorCode, message: string) {
    super(`Sendcloud ${code}: ${message}`);
    this.name = 'SendcloudConfigError';
    this.code = code;
  }
}

/** Statuses a retry may fix: throttling, timeouts and server-side faults. */
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

export function isRetryableSendcloudError(err: SendcloudApiError | SendcloudConfigError): boolean {
  if (err instanceof SendcloudConfigError) return false;
  return err.status >= 500 || RETRYABLE_STATUSES.has(err.status);
}
