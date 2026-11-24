/**
 * Sendcloud API v3 request builders — pure, no I/O.
 */
import type { OrderForShipment } from '@/lib/carriers/types';
import { SendcloudConfigError } from './errors';

/** One parcel's physical size, from the packing estimate (src/lib/packing.ts). */
export type SendcloudParcelSpec = {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

export type SendcloudAnnounceRequest = {
  label_details: { mime_type: 'application/pdf'; dpi: number };
  from_address: { sender_address_id: number };
  to_address: {
    name: string;
    address_line_1: string;
    house_number?: string;
    postal_code: string;
    city: string;
    country_code: string;
    email: string;
    phone_number: string;
  };
  to_service_point: { id: string };
  ship_with: { type: 'shipping_option_code'; properties: { shipping_option_code: string } };
  order_number: string;
  external_reference_id: string;
  parcels: Array<{
    weight: { value: string; unit: 'kg' };
    dimensions: { length: string; width: string; height: string; unit: 'cm' };
  }>;
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Sendcloud's idempotency key for an order's shipment: `orders.id:<attempt>`.
 * Replays reuse the persisted attempt (409 → the existing shipment); only an
 * admin recreate advances it, so a recreate after a cancel gets a new shipment.
 */
export function sendcloudReference(order: Pick<OrderForShipment, 'id' | 'shipment_attempt'>): string {
  return `${order.id}:${order.shipment_attempt ?? 0}`;
}

/**
 * Build the `POST /shipments/announce` body for a paid locker/point order.
 * Throws for incomplete orders: a Sendcloud shipment needs the recipient's
 * name, email and phone (InPost sends the pickup code to them) and the chosen
 * point. The point's own address stands in for `to_address` — checkout collects
 * no home address for point deliveries.
 */
export function buildAnnounceRequest(
  order: OrderForShipment,
  opts: { senderAddressId: number; shippingOptionCode: string; parcel: SendcloudParcelSpec },
): SendcloudAnnounceRequest {
  const firstName = str(order.receiver_first_name);
  const lastName = str(order.receiver_last_name);
  const email = str(order.email);
  const phone = str(order.receiver_phone);
  if (!firstName || !lastName || !email || !phone) {
    throw new Error(`buildAnnounceRequest: incomplete receiver for order ${order.id}`);
  }

  const point = order.delivery_point;
  const pointId = str(point?.id);
  const street = str(point?.street);
  const postCode = str(point?.post_code);
  const city = str(point?.city);
  const country = str(order.delivery_country) ?? str(point?.country);
  if (!point || !pointId || !street || !postCode || !city || !country) {
    throw new SendcloudConfigError('missing_delivery_point', `order ${order.id} has no complete pickup point`);
  }
  const houseNumber = str(point.house_number);

  const { parcel } = opts;
  const decimal = (n: number, digits: number) => n.toFixed(digits);

  return {
    label_details: { mime_type: 'application/pdf', dpi: 72 },
    from_address: { sender_address_id: opts.senderAddressId },
    to_address: {
      name: `${firstName} ${lastName}`,
      address_line_1: street,
      ...(houseNumber ? { house_number: houseNumber } : {}),
      postal_code: postCode,
      city,
      country_code: country.toUpperCase(),
      email,
      phone_number: phone,
    },
    to_service_point: { id: pointId },
    ship_with: { type: 'shipping_option_code', properties: { shipping_option_code: opts.shippingOptionCode } },
    order_number: order.id,
    external_reference_id: sendcloudReference(order),
    parcels: [
      {
        weight: { value: decimal(parcel.weightKg, 3), unit: 'kg' },
        dimensions: {
          length: decimal(parcel.lengthCm, 2),
          width: decimal(parcel.widthCm, 2),
          height: decimal(parcel.heightCm, 2),
          unit: 'cm',
        },
      },
    ],
  };
}
