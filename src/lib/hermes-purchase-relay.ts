/**
 * Hermes purchase relay: after a paid order, POST a minimal, PII-free purchase
 * summary to a Hermes Agent webhook route (Generic V2 signature).
 *
 * Why a relay and not Stripe → Hermes directly: Hermes' dashboard routes only
 * accept the Generic scheme (`X-Webhook-Signature-V2` + `X-Webhook-Timestamp`),
 * while Stripe signs with `Stripe-Signature`. This shop already verifies the
 * Stripe event, so it re-signs the order data for Hermes.
 *
 * Signing: hex HMAC-SHA256 over `<unix-seconds>.<raw body>` (Hermes accepts
 * ±300 s). `X-Request-ID` carries a deterministic id so Hermes dedupes a
 * redelivery inside its 1 h window; `event_type` in the body feeds Hermes'
 * `events` filter.
 *
 * Best-effort and fail-open: unset URL/secret = no-op, and a failure never
 * affects the Stripe webhook response (the order is already persisted).
 * Buyer PII (email, name, phone, address) is deliberately NOT sent.
 */
import * as Sentry from '@sentry/nextjs';

export const HERMES_PURCHASE_EVENT = 'purchase.paid';
const SEND_TIMEOUT_MS = 8000;

export type HermesPurchaseOrder = {
  id: string;
  payment_intent_id: string;
  status: string;
  paid_at?: string | null;
  currency: string;
  subtotal: number; // minor units, pre-discount
  shipping: number;
  discount: number;
  total: number;
  promo_code: string | null;
  delivery_method?: string | null;
  delivery_country?: string | null;
  items: Array<{ product_id: string; unit_price: number }>;
};

export type HermesPurchaseDeps = {
  loadOrder: (paymentIntentId: string) => Promise<HermesPurchaseOrder | null>;
  url?: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  /** Unix seconds; injectable for tests. */
  nowSeconds?: () => number;
};

export function buildHermesPurchasePayload(order: HermesPurchaseOrder) {
  return {
    event_type: HERMES_PURCHASE_EVENT,
    order_id: order.id,
    payment_intent_id: order.payment_intent_id,
    paid_at: order.paid_at ?? null,
    currency: order.currency,
    // Minor units (grosze / euro-cents / pence), same as the orders table.
    subtotal: order.subtotal,
    shipping: order.shipping,
    discount: order.discount,
    total: order.total,
    // Convenience for message templates (major units, two decimals).
    total_display: `${(order.total / 100).toFixed(2)} ${order.currency.toUpperCase()}`,
    promo_code: order.promo_code,
    delivery_method: order.delivery_method ?? null,
    delivery_country: order.delivery_country ?? null,
    item_count: order.items.length,
    items: order.items.map((i) => ({ product_id: i.product_id, unit_price: i.unit_price })),
  };
}

/** Hex HMAC-SHA256 of `<timestamp>.<body>` (Hermes Generic V2). */
export async function signHermesBody(secret: string, timestamp: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Returns true when a delivery was attempted and Hermes answered 2xx. Never throws. */
export async function sendPurchaseToHermes(paymentIntentId: string, deps: HermesPurchaseDeps): Promise<boolean> {
  const url = deps.url?.trim();
  const secret = deps.secret?.trim();
  if (!url || !secret) return false;

  try {
    const order = await deps.loadOrder(paymentIntentId);
    // Only a settled sale is relayed: markPaid's refund-then-fail paths end `failed`.
    if (!order || order.status !== 'paid') return false;

    const body = JSON.stringify(buildHermesPurchasePayload(order));
    const timestamp = String((deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))());
    const signature = await signHermesBody(secret, timestamp, body);

    const res = await (deps.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature-v2': signature,
        'x-request-id': `purchase-${paymentIntentId}`,
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('hermes purchase relay non-2xx for', paymentIntentId, res.status);
      Sentry.captureMessage('hermes_purchase_relay_failed', {
        level: 'warning',
        extra: { payment_intent_id: paymentIntentId, status: res.status },
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error('hermes purchase relay failed for', paymentIntentId, err);
    Sentry.captureException(err);
    return false;
  }
}
