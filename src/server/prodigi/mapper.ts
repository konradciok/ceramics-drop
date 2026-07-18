import { getWorkerOrigin } from '@/lib/site.server';
import { buildProdigiAttributes } from '@/lib/print-prodigi-attributes';
import { normalizeShippingAddress } from '@/lib/shipping-address';
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
  shipping_address: unknown;
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
    assetId: string;
    assetKey: string;
    assetSha256: string;
    assetContentType: 'image/jpeg' | 'image/png';
    assetWidthPx: number;
    assetHeightPx: number;
  };
}

function assertSnapshotDimensions(item: PrintItemRow): void {
  const { variant } = item;
  if (
    variant.assetWidthPx !== variant.printAreaPx.w ||
    variant.assetHeightPx !== variant.printAreaPx.h
  ) {
    throw new Error(
      `asset dimensions ${variant.assetWidthPx}x${variant.assetHeightPx} do not match print area ${variant.printAreaPx.w}x${variant.printAreaPx.h} for ${item.product_id} (asset ${variant.assetId})`,
    );
  }
}

const CURRENCY_CODE: Record<'pln' | 'eur' | 'gbp', string> = {
  pln: 'PLN', eur: 'EUR', gbp: 'GBP',
};

/** Amount in major units (Prodigi expects decimal string, e.g. "35.00"). */
function majorAmount(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}

function buildRecipient(order: OrderRow): ProdigiRecipient {
  const a = normalizeShippingAddress(order.shipping_address);
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
      line1:            a.line1,
      ...(a.line2 ? { line2: a.line2 } : {}),
      postalOrZipCode:  a.post_code,
      countryCode:      a.country_code,
      townOrCity:       a.city,
    },
  };
}

export function buildProdigiPayload(
  order: OrderRow,
  printItems: PrintItemRow[],
  assetUrls: Record<string, string>,  // assetId → signed URL
  env: CloudflareEnv,
): ProdigiOrderRequest {
  const items: ProdigiOrderItem[] = printItems.map((item) => {
    assertSnapshotDimensions(item);
    const assetUrl = assetUrls[item.variant.assetId];
    if (!assetUrl) {
      throw new Error(`missing Prodigi asset URL for asset ${item.variant.assetId} (${item.product_id})`);
    }
    return {
      sku:    item.variant.prodigiSku,
      copies: 1,
      sizing: 'fillPrintArea',
      attributes: buildProdigiAttributes(item.variant),
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
    // ponytail: Prodigi's API only accepts a plain callbackUrl string — no custom request headers.
    // URL token is the only available auth mechanism; Prodigi does not sign outgoing callbacks.
    callbackUrl:       `${getWorkerOrigin(env)}/api/webhooks/prodigi/${env.PRODIGI_CALLBACK_TOKEN}`,
    merchantReference: order.id,
    recipient:         buildRecipient(order),
    items,
    metadata: { internal_order_id: order.id },
  };
}
