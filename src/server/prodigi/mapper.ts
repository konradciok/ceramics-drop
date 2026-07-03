import { SITE_URL } from '@/lib/site';
import type { ProdigiOrderItem, ProdigiOrderRequest, ProdigiRecipient } from './types';

/**
 * Order row exactly as persisted by /api/checkout: contact spread over
 * email + receiver_* columns, address in ShipX shape (src/lib/shipx.ts
 * DeliveryAddress) — mapped to Prodigi's recipient shape here.
 */
export interface OrderRow {
  id: string;
  currency: 'pln' | 'eur' | 'gbp';
  email: string;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  receiver_phone: string | null;
  shipping_address: {
    street: string;
    building_number: string;
    city: string;
    post_code: string;
    country_code: string;
  } | null;
  delivery_method: string;
}

export interface PrintItemRow {
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
function majorAmount(minorUnits: number): string {
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
  const a = order.shipping_address;
  if (!a) {
    throw new Error(
      `order ${order.id} has no shipping_address (delivery_method=${order.delivery_method}) — prints require a courier address`,
    );
  }
  return {
    name: [order.receiver_first_name, order.receiver_last_name].filter(Boolean).join(' '),
    email: order.email,
    phoneNumber: order.receiver_phone ?? undefined,
    address: {
      line1:            `${a.street} ${a.building_number}`.trim(),
      postalOrZipCode:  a.post_code,
      countryCode:      a.country_code,
      townOrCity:       a.city,
    },
  };
}

export function buildProdigiPayload(
  order: OrderRow,
  printItems: PrintItemRow[],
  assetUrls: Record<string, string>,  // product_id → presigned URL
  env: CloudflareEnv,
): ProdigiOrderRequest {
  const items: ProdigiOrderItem[] = printItems.map((item) => {
    const assetUrl = assetUrls[item.product_id];
    if (!assetUrl) {
      throw new Error(`missing Prodigi asset URL for product ${item.product_id}`);
    }
    return {
      sku:    item.variant.prodigiSku,
      copies: 1,
      sizing: 'fillPrintArea',
      attributes: buildAttributes(item.variant),
      assets: [{ printArea: 'default', url: assetUrl }],
      recipientCost: {
        amount:   majorAmount(item.unit_price),
        currency: CURRENCY_CODE[order.currency],
      },
    };
  });

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
