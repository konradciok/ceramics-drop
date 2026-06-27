import type { ProdigiOrderRequest, ProdigiOrderResponse, ProdigiProductResponse } from './types';

export class ProdigiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProdigiError';
  }
}

function baseUrl(env: CloudflareEnv): string {
  return env.PRODIGI_ENV === 'live'
    ? 'https://api.prodigi.com/v4.0'
    : 'https://api.sandbox.prodigi.com/v4.0';
}

function apiKey(env: CloudflareEnv): string {
  return env.PRODIGI_ENV === 'live'
    ? env.PRODIGI_API_KEY_LIVE
    : env.PRODIGI_API_KEY_SANDBOX;
}

async function request<T>(
  env: CloudflareEnv,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl(env)}${path}`, {
      method,
      headers: {
        'X-API-Key': apiKey(env),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ProdigiError(`Network error: ${String(e)}`, null, true);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 409 from Prodigi means idempotent duplicate — not retryable, not an error.
    // Caller must check outcome field.
    const retryable = res.status >= 500 || res.status === 429;
    throw new ProdigiError(`Prodigi ${res.status}: ${text}`, res.status, retryable);
  }

  return res.json() as Promise<T>;
}

export function prodigiClient(env: CloudflareEnv) {
  return {
    postOrder: (payload: ProdigiOrderRequest) =>
      request<ProdigiOrderResponse>(env, 'POST', '/orders', payload),

    getOrder: (prodigiOrderId: string) =>
      request<{ order: ProdigiOrderResponse['order'] }>(env, 'GET', `/orders/${prodigiOrderId}`),

    getProduct: (sku: string) =>
      request<ProdigiProductResponse>(env, 'GET', `/products/${sku}`),
  };
}
