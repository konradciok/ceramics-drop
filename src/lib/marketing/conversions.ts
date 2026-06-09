import * as Sentry from '@sentry/nextjs';
import { resolveKnownProducts } from '../products';
import { toAnalyticsItem } from '../analytics';
import { hashUserField, normalizeEmail, normalizePhonePl, normalizeText, sha256Hex } from './hash';
import { sendMetaPurchase, type MetaCapiConfig, type MetaPurchaseInput } from './meta-capi';
import { sendGa4Purchase, type Ga4Config, type Ga4PurchaseInput } from './ga4-mp';
import type { MarketingContext } from './context';
import type { DeliveryAddress } from '../shipx';

export type ConversionOrder = {
  payment_intent_id: string;
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
  items: Array<{ product_id: string; unit_price: number }>;
};

export type ConversionsDeps = {
  loadOrder: (paymentIntentId: string) => Promise<ConversionOrder | null>;
  metaConfig: MetaCapiConfig;
  ga4Config: Ga4Config;
  eventTimeSecs: number;
  sendMeta?: typeof sendMetaPurchase;
  sendGa4?: typeof sendGa4Purchase;
};

export async function sendPurchaseConversions(
  paymentIntentId: string,
  deps: ConversionsDeps,
): Promise<void> {
  const order = await deps.loadOrder(paymentIntentId);
  if (!order || !order.marketing || order.marketing.consent !== 'granted') return;

  const m = order.marketing;
  const ids = order.items.map((i) => i.product_id);
  const products = resolveKnownProducts(ids);
  const analyticsItems = products.map((p) => toAnalyticsItem(p));

  const emailHash = await hashUserField(order.email, normalizeEmail);

  const metaInput: MetaPurchaseInput = {
    eventId: `purchase-${order.payment_intent_id}`,
    eventTimeSecs: deps.eventTimeSecs,
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
    contents: analyticsItems.map((it) => ({ id: it.item_id, quantity: 1, item_price: it.price })),
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
    items: analyticsItems.map((it) => ({
      item_id: it.item_id,
      item_name: it.item_name,
      price: it.price,
      quantity: 1 as const,
      item_category: it.item_category,
      item_brand: it.item_brand,
    })),
    ...(emailHash ? { userData: { sha256_email_address: emailHash[0] } } : {}),
  };

  const sendMeta = deps.sendMeta ?? sendMetaPurchase;
  const sendGa4 = deps.sendGa4 ?? sendGa4Purchase;

  try {
    await sendMeta(deps.metaConfig, metaInput);
  } catch (err) {
    console.error('meta capi purchase failed for', paymentIntentId, err);
    Sentry.captureException(err);
  }
  try {
    await sendGa4(deps.ga4Config, ga4Input);
  } catch (err) {
    console.error('ga4 mp purchase failed for', paymentIntentId, err);
    Sentry.captureException(err);
  }
}

// Re-export for callers that build the time argument.
export { sha256Hex };
