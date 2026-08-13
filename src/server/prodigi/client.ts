import type {
  ProdigiCancelResponse,
  ProdigiOrderListParams,
  ProdigiOrderListResponse,
  ProdigiOrderActionsResponse,
  ProdigiOrderRequest,
  ProdigiOrderResponse,
  ProdigiProductResponse,
  ProdigiQuoteRequest,
  ProdigiQuoteResponse,
  ProdigiRecipient,
  ProdigiSpineRequest,
  ProdigiSpineResponse,
  ProdigiUpdateMetadataResponse,
  ProdigiUpdateMetadataRequest,
  ProdigiUpdateRecipientResponse,
  ProdigiUpdateShippingResponse,
} from './types';

export class ProdigiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
    /** Parsed JSON response body when available — 409 duplicates carry the existing order. */
    public readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'ProdigiError';
  }
}

function baseUrl(env: CloudflareEnv): string {
  // Live mode returns unconditionally BEFORE the override is read: the
  // rehearsal-only PRODIGI_API_BASE_URL knob (failure injection, Plan 05) can
  // only ever replace the sandbox URL, never redirect production traffic.
  if (env.PRODIGI_ENV === 'live') return 'https://api.prodigi.com/v4.0';
  const override = env.PRODIGI_API_BASE_URL?.trim().replace(/\/+$/, '');
  return override || 'https://api.sandbox.prodigi.com/v4.0';
}

function apiKey(env: CloudflareEnv): string {
  return env.PRODIGI_ENV === 'live'
    ? env.PRODIGI_API_KEY_LIVE
    : env.PRODIGI_API_KEY_SANDBOX;
}

/**
 * M-11: a hung Prodigi endpoint must become a bounded, RETRYABLE failure
 * (→ queue backoff / DLQ / callback 500-with-released-claim), never an
 * indefinitely stalled consumer. AbortController + setTimeout is the repo's
 * proven timeout pattern (worker.ts Resend sends).
 */
export const PRODIGI_TIMEOUT_MS = 15_000;

async function request<T>(
  env: CloudflareEnv,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRODIGI_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${baseUrl(env)}${path}`, {
        method,
        headers: {
          'X-API-Key': apiKey(env),
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new ProdigiError(`Prodigi timeout after ${PRODIGI_TIMEOUT_MS} ms: ${method} ${path}`, null, true);
      }
      throw new ProdigiError(`Network error: ${String(e)}`, null, true);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 409 from Prodigi means idempotencyKey duplicate — processJob recovers the
      // existing order id from `body` instead of failing the job.
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
      const retryable = res.status >= 500 || res.status === 429;
      throw new ProdigiError(`Prodigi ${res.status}: ${text}`, res.status, retryable, parsed);
    }

    // Awaited inside the try so the abort timer also bounds the body read; an
    // abort mid-body still surfaces via the signal, not as a silent hang.
    try {
      return await (res.json() as Promise<T>);
    } catch (e) {
      if (controller.signal.aborted) {
        throw new ProdigiError(`Prodigi timeout after ${PRODIGI_TIMEOUT_MS} ms: ${method} ${path}`, null, true);
      }
      throw e;
    }
  } finally {
    clearTimeout(timer);
  }
}

function orderListPath(params: ProdigiOrderListParams = {}): string {
  const query = new URLSearchParams();
  if (params.top !== undefined) query.set('top', String(params.top));
  if (params.skip !== undefined) query.set('skip', String(params.skip));
  if (params.createdFrom !== undefined) query.set('createdFrom', params.createdFrom);
  if (params.createdTo !== undefined) query.set('createdTo', params.createdTo);
  if (params.status !== undefined) query.set('status', params.status);
  for (const id of params.orderIds ?? []) query.append('orderIds', id);
  for (const reference of params.merchantReferences ?? []) {
    query.append('merchantReferences', reference);
  }
  const encoded = query.toString();
  return encoded ? `/orders?${encoded}` : '/orders';
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function prodigiClient(env: CloudflareEnv) {
  return {
    postOrder: (payload: ProdigiOrderRequest) =>
      request<ProdigiOrderResponse>(env, 'POST', '/orders', payload),

    getOrder: (prodigiOrderId: string) =>
      request<{ order: ProdigiOrderResponse['order'] }>(env, 'GET', `/orders/${pathSegment(prodigiOrderId)}`),

    listOrders: (params?: ProdigiOrderListParams) =>
      request<ProdigiOrderListResponse>(env, 'GET', orderListPath(params)),

    getOrderActions: (prodigiOrderId: string) =>
      request<ProdigiOrderActionsResponse>(env, 'GET', `/orders/${pathSegment(prodigiOrderId)}/actions`),

    cancelOrder: (prodigiOrderId: string) =>
      request<ProdigiCancelResponse>(env, 'POST', `/orders/${pathSegment(prodigiOrderId)}/actions/cancel`),

    updateShippingMethod: (prodigiOrderId: string, shippingMethod: string) =>
      request<ProdigiUpdateShippingResponse>(
        env,
        'POST',
        `/orders/${pathSegment(prodigiOrderId)}/actions/updateShippingMethod`,
        { shippingMethod },
      ),

    updateRecipient: (prodigiOrderId: string, recipient: ProdigiRecipient) =>
      request<ProdigiUpdateRecipientResponse>(
        env,
        'POST',
        `/orders/${pathSegment(prodigiOrderId)}/actions/updateRecipient`,
        recipient,
      ),

    updateMetadata: (prodigiOrderId: string, payload: ProdigiUpdateMetadataRequest) =>
      request<ProdigiUpdateMetadataResponse>(
        env,
        'POST',
        `/orders/${pathSegment(prodigiOrderId)}/actions/updateMetadata`,
        payload,
      ),

    getProduct: (sku: string) =>
      request<ProdigiProductResponse>(env, 'GET', `/products/${pathSegment(sku)}`),

    postQuote: (payload: ProdigiQuoteRequest) =>
      request<ProdigiQuoteResponse>(env, 'POST', '/quotes', payload),

    postSpine: (payload: ProdigiSpineRequest) =>
      request<ProdigiSpineResponse>(env, 'POST', '/products/spine', payload),
  };
}
