import * as Sentry from '@sentry/nextjs';
import { resolveKnownProducts } from '../products';
import { getPrintById } from '../prints';
import { variantLabel } from '../print-cart';
import { toAnalyticsItem } from '../analytics';
import { hashUserField, normalizeEmail, normalizePhonePl, normalizeText, sha256Hex } from './hash';
import { sendMetaPurchase, type MetaCapiConfig, type MetaPurchaseInput } from './meta-capi';
import { sendGa4Purchase, type Ga4Config, type Ga4PurchaseInput } from './ga4-mp';
import type { MarketingContext } from './context';
import type { DeliveryAddress } from '../shipx';

export type ConversionOrder = {
  payment_intent_id: string;
  status: string;
  subtotal: number; // grosze
  shipping: number; // grosze
  total: number;    // grosze
  currency: string;
  email: string | null;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  receiver_phone: string | null;
  shipping_address: DeliveryAddress | null;
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
    resolveKnownProducts(ids).map((p) => [p.id, p]),
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
      const design = getPrintById(item.product_id);
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
    };
  });

  const emailHash = await hashUserField(order.email, normalizeEmail);

  const metaInput: MetaPurchaseInput = {
    eventId: `purchase-${order.payment_intent_id}`,
    eventTimeSecs,
    eventSourceUrl: m.event_source_url,
    userData: {
      em: emailHash,
      ph: await hashUserField(order.receiver_phone, normalizePhonePl),
      fn: await hashUserField(order.receiver_first_name, (v) => normalizeText(v)),
      ln: await hashUserField(order.receiver_last_name, (v) => normalizeText(v)),
      ct: await hashUserField(order.shipping_address?.city ?? null, (v) => normalizeText(v, { stripSpaces: true })),
      zp: await hashUserField(order.shipping_address?.post_code ?? null, (v) => normalizeText(v, { stripSpaces: true })),
      country: await hashUserField(order.shipping_address?.country_code ?? null, (v) => normalizeText(v, { stripSpaces: true })),
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
    value: order.subtotal / 100,
    shipping: order.shipping / 100,
    currency: order.currency.toUpperCase(),
    items: ga4Items,
    ...(emailHash ? { userData: { sha256_email_address: emailHash[0] } } : {}),
  };

  const sendMeta = deps.sendMeta ?? sendMetaPurchase;
  const sendGa4 = deps.sendGa4 ?? sendGa4Purchase;

  if (deps.metaConfig) {
    try {
      const result = await sendMeta(deps.metaConfig, metaInput);
      if (!result.ok) {
        console.error('meta capi purchase http error for', paymentIntentId, result.status);
        Sentry.captureMessage(`meta capi purchase http error ${result.status} for ${paymentIntentId}`);
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
        console.error('ga4 mp purchase http error for', paymentIntentId, result.status);
        Sentry.captureMessage(`ga4 mp purchase http error ${result.status} for ${paymentIntentId}`);
      }
    } catch (err) {
      console.error('ga4 mp purchase failed for', paymentIntentId, err);
      Sentry.captureException(err);
    }
  }
}

// Re-export for callers that build the time argument.
export { sha256Hex };
