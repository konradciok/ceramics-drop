/**
 * Sendcloud Service Points API v3 — the server-side re-check of the point a
 * buyer picked in the hosted picker. Pure, no I/O.
 *
 * The browser only sends the point's id: the picker runs on the buyer's
 * device, so its country, carrier and address are never trusted. Checkout
 * re-reads the point (GET /service-points/{id}) and keeps what Sendcloud says.
 */
import type { DeliveryPoint } from '@/lib/carriers/types';

/** The fields of a v3 `ServicePointDetail` this shop reads. */
export type SendcloudServicePoint = {
  id: number | string;
  name?: string | null;
  carrier?: { code?: string | null } | null;
  carrier_service_point_id?: string | null;
  general_shop_type?: string | null;
  address?: {
    street?: string | null;
    house_number?: string | null;
    postal_code?: string | null;
    city?: string | null;
    country_code?: string | null;
  } | null;
  is_expired?: boolean | null;
};

export type ServicePointCheck =
  | { ok: true; point: DeliveryPoint }
  | { ok: false; reason: 'not_found' | 'wrong_carrier' | 'wrong_country' | 'expired' | 'incomplete' | 'not_available' };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Whether the point Sendcloud returned can take this order: it exists, is
 * operated for the lane's carrier, sits in the chosen country, is not stale,
 * and has the address a shipment is addressed to. Returns the point as
 * `orders.delivery_point` stores it.
 */
export function checkServicePoint(
  point: SendcloudServicePoint | null,
  expected: { country: string; carrier: string },
): ServicePointCheck {
  if (!point) return { ok: false, reason: 'not_found' };
  if (point.carrier?.code !== expected.carrier) return { ok: false, reason: 'wrong_carrier' };
  const country = str(point.address?.country_code)?.toUpperCase() ?? null;
  if (country !== expected.country.toUpperCase()) return { ok: false, reason: 'wrong_country' };
  if (point.is_expired === true) return { ok: false, reason: 'expired' };

  const street = str(point.address?.street);
  const postCode = str(point.address?.postal_code);
  const city = str(point.address?.city);
  if (!street || !postCode || !city) return { ok: false, reason: 'incomplete' };

  return {
    ok: true,
    point: {
      id: String(point.id),
      code: str(point.carrier_service_point_id),
      carrier: expected.carrier,
      name: str(point.name),
      street,
      house_number: str(point.address?.house_number),
      post_code: postCode,
      city,
      country,
    },
  };
}
