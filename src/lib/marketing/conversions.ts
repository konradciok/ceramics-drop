import * as Sentry from '@sentry/nextjs';
import { registryResolveKnownProducts } from '../products';
import { registryPrintById } from '../prints';
import { variantLabel } from '../print-cart';
import { toAnalyticsItem } from '../analytics';
import { hashUserField, normalizeEmail, normalizePhonePl, normalizeText, sha256Hex } from './hash';
import { sendMetaPurchase, parseMetaCapiErrorBody, type MetaCapiConfig, type MetaPurchaseInput } from './meta-capi';
import { sendGa4Purchase, sendGa4Refund, type Ga4Config, type Ga4PurchaseInput, type Ga4RefundInput } from './ga4-mp';
import type { MarketingContext } from './context';
import { normalizeShippingAddress } from '../shipping-address';

export type ConversionOrder = {
  payment_intent_id: string;
  status: string;
  subtotal: number; // grosze, pre-discount
  shipping: number; // grosze
  total: number;    // grosze
  currency: string;
  promo_code: string | null;
  discount: number; // grosze
  email: string | null;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  receiver_phone: string | null;
  shipping_address: unknown;
  marketing: MarketingContext | null;
  items: Array<{
    product_id: string;
    unit_price: number;
    variant?: { size: string; framed: boolean; mount: boolean; frameColour: string; prodigiSku?: string } | null;
  }>;
};

export type ConversionsDeps = {
  loadOrder: (paymentIntentId: string) => Promise<ConversionOrder | null>;
  metaConfig?: MetaCapiConfig;
  ga4Config?: Ga4Config;
  sendMeta?: typeof sendMetaPurchase;
  sendGa4?: typeof sendGa4Purchase;
  appVersion?: string;
  appGitSha?: string;
};

export async function sendPurchaseConversions(
  paymentIntentId: string,
  deps: ConversionsDeps,
): Promise<void> {
  const order = await deps.loadOrder(paymentIntentId);
  if (!order || !order.marketing || order.marketing.consent !== 'granted') return;
  if (order.status !== 'paid') return;

  const m = order.marketing;
  const eventTimeSecs = Math.floor(new Date(m.captured_at).getTime() / 1000);
  const ids = order.items.map((i) => i.product_id);

  const productById = new Map(
    registryResolveKnownProducts(ids).map((p) => [p.id, p]),
  );

  const metaContents = order.items.map((item) => ({
    id: item.product_id,
    quantity: 1 as const,
    item_price: item.unit_price / 100,
  }));

  const ga4Items = order.items.map((item) => {
    // Print line: ceramic registry can't resolve a design id, so build the item
    // from the print registry + persisted variant (value/contents already correct).
    if (item.variant) {
      const design = registryPrintById(item.product_id);
      return {
        item_id: item.product_id,
        item_name: design ? `Print Nº ${design.num}` : item.product_id,
        price: item.unit_price / 100,
        quantity: 1 as const,
        item_category: 'fine-art-prints',
        item_brand: 'Anna Ciok Ceramics',
        item_variant: variantLabel(item.variant as Parameters<typeof variantLabel>[0], 'en'),
      };
    }
    const p = productById.get(item.product_id);
    const ai = p ? toAnalyticsItem(p) : null;
    return {
      item_id: item.product_id,
      item_name: ai?.item_name ?? item.product_id,
      price: item.unit_price / 100,
      quantity: 1 as const,
      item_category: ai?.item_category ?? '',
      item_brand: ai?.item_brand ?? 'Anna Ciok Ceramics',
      // N-4: mirror the client's item_variant (`Nº <num>`) so browser and server GA4
      // purchase items agree — GA4 keeps whichever hit lands first per transaction_id.
      ...(ai?.item_variant ? { item_variant: ai.item_variant } : {}),
    };
  });

  const emailHash = await hashUserField(order.email, normalizeEmail);
  const shippingAddress = normalizeShippingAddress(order.shipping_address);

  const metaInput: MetaPurchaseInput = {
    eventId: `purchase-${order.payment_intent_id}`,
    eventTimeSecs,
    eventSourceUrl: m.event_source_url,
    userData: {
      em: emailHash,
      ph: await hashUserField(order.receiver_phone, normalizePhonePl),
      fn: await hashUserField(order.receiver_first_name, (v) => normalizeText(v)),
      ln: await hashUserField(order.receiver_last_name, (v) => normalizeText(v)),
      ct: await hashUserField(shippingAddress?.city ?? null, (v) => normalizeText(v, { stripSpaces: true })),
      zp: await hashUserField(shippingAddress?.post_code ?? null, (v) => normalizeText(v, { stripSpaces: true })),
      country: await hashUserField(shippingAddress?.country_code ?? null, (v) => normalizeText(v, { stripSpaces: true })),
      client_ip_address: m.ip,
      client_user_agent: m.user_agent,
      fbp: m.fbp,
      fbc: m.fbc,
    },
    value: order.total / 100,
    currency: order.currency.toUpperCase(),
    contentIds: ids,
    contents: metaContents,
    numItems: ids.length,
    orderId: order.payment_intent_id,
  };

  const ga4Input: Ga4PurchaseInput = {
    clientId: m.ga_client_id,
    sessionId: m.ga_session_id,
    transactionId: order.payment_intent_id,
    // (subtotal - discount)/100 — Meta needs no change (order.total is already post-discount).
    value: (order.subtotal - (order.discount ?? 0)) / 100,
    shipping: order.shipping / 100,
    currency: order.currency.toUpperCase(),
    items: ga4Items,
    ...(emailHash ? { userData: { sha256_email_address: emailHash[0] } } : {}),
    ...(deps.appVersion ? { appVersion: deps.appVersion } : {}),
    ...(deps.appGitSha ? { appGitSha: deps.appGitSha } : {}),
    ...(order.promo_code ? { coupon: order.promo_code } : {}),
  };

  const sendMeta = deps.sendMeta ?? sendMetaPurchase;
  const sendGa4 = deps.sendGa4 ?? sendGa4Purchase;

  if (deps.metaConfig) {
    try {
      const result = await sendMeta(deps.metaConfig, metaInput);
      if (!result.ok) {
        console.error('meta capi purchase http error for', paymentIntentId, result.status, result.errorBody);
        // Fingerprint on the *parsed*, stable error fields (type/code/subcode) — not the
        // raw errorBody or payment_intent_id. Meta's error body always includes a
        // per-request `fbtrace_id`, so fingerprinting on the raw string would still split
        // every failing order into its own issue, defeating the point of this fingerprint.
        const metaError = parseMetaCapiErrorBody(result.errorBody);
        Sentry.captureMessage(`meta capi purchase http error ${result.status}${metaError.type ? ` (${metaError.type})` : ''}`, {
          level: 'error',
          fingerprint: [
            'meta-capi-purchase-http-error',
            String(result.status),
            metaError.type ?? '',
            String(metaError.code ?? ''),
            String(metaError.errorSubcode ?? ''),
          ],
          extra: {
            payment_intent_id: paymentIntentId,
            status: result.status,
            response_body: result.errorBody,
            meta_error_type: metaError.type,
            meta_error_code: metaError.code,
            meta_error_subcode: metaError.errorSubcode,
          },
        });
      }
    } catch (err) {
      console.error('meta capi purchase failed for', paymentIntentId, err);
      Sentry.captureException(err);
    }
  }

  if (deps.ga4Config) {
    try {
      const result = await sendGa4(deps.ga4Config, ga4Input);
      if (result.skipped) {
        // Reached only past the consent + paid gates above, so consent is granted and
        // the order is paid — yet GA4 MP was skipped because ga_client_id was null
        // (cookie missing or cleared by Safari ITP before checkout). The server-side
        // GA4 purchase never fires; flag it as a warning so the attribution gap is
        // searchable in Sentry instead of audit-only.
        console.warn('ga4 mp purchase skipped (consent granted, no clientId) for', paymentIntentId);
        Sentry.captureMessage('ga4 mp purchase skipped (consent granted, no clientId)', {
          level: 'warning',
          extra: {
            payment_intent_id: paymentIntentId,
            channel: 'ga4_mp',
            reason: 'no_client_id',
          },
        });
      } else if (!result.ok) {
        console.error('ga4 mp purchase http error for', paymentIntentId, result.status, result.errorBody);
        // Same grouping fix as the Meta branch above: fingerprint on status + body
        // (stable across orders — GA4 MP errors don't embed a per-request trace id)
        // instead of interpolating payment_intent_id into the message.
        Sentry.captureMessage(`ga4 mp purchase http error ${result.status}`, {
          level: 'error',
          fingerprint: ['ga4-mp-purchase-http-error', String(result.status), result.errorBody ?? ''],
          extra: { payment_intent_id: paymentIntentId, status: result.status, response_body: result.errorBody },
        });
      }
    } catch (err) {
      console.error('ga4 mp purchase failed for', paymentIntentId, err);
      Sentry.captureException(err);
    }
  }
}

export type RefundOrder = {
  payment_intent_id: string;
  subtotal: number; // grosze, pre-discount
  shipping: number; // grosze
  currency: string;
  discount: number; // grosze
  marketing: MarketingContext | null;
};

export type RefundConversionsDeps = {
  ga4Config?: Ga4Config;
  sendGa4Refund?: typeof sendGa4Refund;
};

/**
 * GA4-only: Meta doesn't support un-firing a conversion. Fires only for a real
 * paid→refunded transition (see releaseSale in route.ts) — never for the
 * pending→refunded race, since no purchase was ever recorded as revenue there.
 */
export async function sendRefundConversion(
  order: RefundOrder,
  deps: RefundConversionsDeps,
): Promise<void> {
  if (!order.marketing || order.marketing.consent !== 'granted') return;
  if (!deps.ga4Config) return;

  // Input construction (order.currency.toUpperCase() etc.) is inside the try,
  // not before it — releaseSale awaits this function, so a throw here on
  // malformed persisted data (e.g. a null currency) must not escape and block
  // the piece-relist/webhook-response path this function is meant to be
  // best-effort against.
  try {
    const send = deps.sendGa4Refund ?? sendGa4Refund;
    const refundInput: Ga4RefundInput = {
      clientId: order.marketing.ga_client_id,
      sessionId: order.marketing.ga_session_id,
      transactionId: order.payment_intent_id,
      // Reverses exactly the revenue the purchase recorded — same
      // (subtotal - discount)/100 rule as sendPurchaseConversions above.
      value: (order.subtotal - (order.discount ?? 0)) / 100,
      shipping: order.shipping / 100,
      currency: order.currency.toUpperCase(),
    };
    const result = await send(deps.ga4Config, refundInput);
    if (result.skipped) {
      console.warn('ga4 mp refund skipped (consent granted, no clientId) for', order.payment_intent_id);
      return;
    }
    if (!result.ok) {
      console.error('ga4 mp refund http error for', order.payment_intent_id, result.status, result.errorBody);
      Sentry.captureMessage(`ga4 mp refund http error ${result.status}`, {
        level: 'error',
        fingerprint: ['ga4-mp-refund-http-error', String(result.status), result.errorBody ?? ''],
        extra: { payment_intent_id: order.payment_intent_id, status: result.status, response_body: result.errorBody },
      });
    }
  } catch (err) {
    console.error('ga4 mp refund failed for', order.payment_intent_id, err);
    Sentry.captureException(err);
  }
}

// Re-export for callers that build the time argument.
export { sha256Hex };
