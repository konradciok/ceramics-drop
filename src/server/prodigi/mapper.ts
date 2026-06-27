import { SITE_URL } from '@/lib/site';
import type { ProdigiOrderItem, ProdigiOrderRequest, ProdigiRecipient } from './types';

interface OrderRow {
  id: string;
  currency: 'pln' | 'eur' | 'gbp';
  contact: { name: string; email: string; phone?: string };
  shipping_address: {
    line1: string; line2?: string; city: string;
    postal_code: string; country: string;
  };
  delivery_method: string;
}

interface PrintItemRow {
  product_id: string;
  unit_price: number;
  variant: {
    prodigiSku: string;
    framed: boolean;
    mount: boolean;
    frameColour: string;
    printAreaPx: { w: number; h: number };
  };
}

const CURRENCY_CODE: Record<'pln' | 'eur' | 'gbp', string> = {
  pln: 'PLN', eur: 'EUR', gbp: 'GBP',
};

/** Amount in major units (Prodigi expects decimal string, e.g. "35.00"). */
function majorAmount(minorUnits: number, currency: 'pln' | 'eur' | 'gbp'): string {
  return (minorUnits / 100).toFixed(2);
}

function buildAttributes(variant: PrintItemRow['variant']): Record<string, string> {
  if (!variant.framed) return {};
  const attrs: Record<string, string> = { color: variant.frameColour };
  if (variant.mount) {
    attrs['mount'] = '2.4mm';
    attrs['mountColor'] = 'Snow white';
  }
  return attrs;
}

function buildRecipient(order: OrderRow): ProdigiRecipient {
  return {
    name: order.contact.name,
    email: order.contact.email,
    phoneNumber: order.contact.phone,
    address: {
      line1:            order.shipping_address.line1,
      line2:            order.shipping_address.line2,
      postalOrZipCode:  order.shipping_address.postal_code,
      countryCode:      order.shipping_address.country,
      townOrCity:       order.shipping_address.city,
    },
  };
}

export function buildProdigiPayload(
  order: OrderRow,
  printItems: PrintItemRow[],
  assetUrls: Record<string, string>,  // product_id → presigned URL
  env: CloudflareEnv,
): ProdigiOrderRequest {
  const items: ProdigiOrderItem[] = printItems.map((item) => ({
    sku:    item.variant.prodigiSku,
    copies: 1,
    sizing: 'fillPrintArea',
    attributes: buildAttributes(item.variant),
    assets: [{ printArea: 'default', url: assetUrls[item.product_id] }],
    recipientCost: {
      amount:   majorAmount(item.unit_price, order.currency),
      currency: CURRENCY_CODE[order.currency],
    },
  }));

  return {
    shippingMethod:    env.PRODIGI_DEFAULT_SHIPPING_METHOD ?? 'Budget',
    idempotencyKey:    `prodigi:${env.PRODIGI_ENV}:order:${order.id}:v1`,
    callbackUrl:       `${SITE_URL}/api/webhooks/prodigi/${env.PRODIGI_CALLBACK_TOKEN}`,
    merchantReference: order.id,
    recipient:         buildRecipient(order),
    items,
    metadata: { internal_order_id: order.id },
  };
}
