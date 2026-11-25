/**
 * Checkout delivery validation — pure, no I/O, carrier-neutral.
 *
 * `validateDelivery` turns the raw checkout body into a typed delivery
 * selection (mirrors `validateCart`'s discriminated-union style).
 */
import { CHECKOUT_DELIVERY_METHODS, type DeliveryMethod } from '@/lib/pricing';
import {
  DESTINATIONS,
  PRIMARY_DESTINATION_COUNTRY,
  checkoutCountries,
  type DestinationCountry,
} from './destinations';
import type { DeliveryAddress, DeliveryContact, ValidateDeliveryResult } from './types';

// Customer-selectable methods only: studio pickup is refused while it is off.
const METHODS = CHECKOUT_DELIVERY_METHODS;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

// A Sendcloud service point id (an integer in their API).
const SERVICE_POINT_ID_RE = /^[1-9][0-9]{0,15}$/;

/**
 * Resolve the raw checkout delivery payload to a typed, validated selection.
 * `countries` is what checkout offers (checkoutCountries()); a body without
 * `delivery_country` is a cart page from before country selection and means
 * Poland.
 */
export function validateDelivery(
  raw: unknown,
  { countries = checkoutCountries() }: { countries?: readonly DestinationCountry[] } = {},
): ValidateDeliveryResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'invalid_method' };
  const body = raw as Record<string, unknown>;

  const method = body.delivery_method;
  if (typeof method !== 'string' || !METHODS.includes(method as DeliveryMethod)) {
    return { ok: false, reason: 'invalid_method' };
  }
  const m = method as DeliveryMethod;

  // Contact: name + email always required; phone required for carrier shipments.
  const c = (body.contact ?? {}) as Record<string, unknown>;
  const first_name = str(c.first_name);
  const last_name = str(c.last_name);
  const email = str(c.email);
  const phone = str(c.phone);
  if (!first_name || !last_name || !email) return { ok: false, reason: 'invalid_contact' };
  if (m !== 'odbior' && !phone) return { ok: false, reason: 'invalid_contact' };

  const contact: DeliveryContact = { first_name, last_name, email, phone: phone ?? '' };

  if (m === 'paczkomat') {
    const rawCountry = body.delivery_country;
    const country = rawCountry === undefined || rawCountry === null ? PRIMARY_DESTINATION_COUNTRY : rawCountry;
    if (typeof country !== 'string' || !(countries as readonly string[]).includes(country)) {
      return { ok: false, reason: 'invalid_country' };
    }
    const destination = DESTINATIONS[country as DestinationCountry];
    if (destination.channel === 'sendcloud') {
      const rawId = typeof body.service_point_id === 'number' ? String(body.service_point_id) : str(body.service_point_id);
      if (!rawId || !SERVICE_POINT_ID_RE.test(rawId)) return { ok: false, reason: 'missing_target_point' };
      return { ok: true, delivery: { method: m, contact, country: destination.country, service_point_id: rawId } };
    }
    const target_point = str(body.target_point);
    if (!target_point) return { ok: false, reason: 'missing_target_point' };
    return { ok: true, delivery: { method: m, contact, country: destination.country, target_point } };
  }

  if (m === 'kurier') {
    const a = (body.address ?? {}) as Record<string, unknown>;
    const street = str(a.street);
    const building_number = str(a.building_number);
    const city = str(a.city);
    const post_code = str(a.post_code);
    if (!street || !building_number || !city || !post_code) {
      return { ok: false, reason: 'invalid_address' };
    }
    const address: DeliveryAddress = {
      street,
      building_number,
      city,
      post_code,
      country_code: str(a.country_code) ?? 'PL',
    };
    // InPost courier is domestic only (switched off: COURIER_ENABLED).
    return { ok: true, delivery: { method: m, contact, country: 'PL', address } };
  }

  // odbior — no shipment, no address/locker.
  return { ok: true, delivery: { method: m, contact } };
}

/** Whether a delivery method results in a carrier shipment (odbior does not). */
export function needsShipment(method: DeliveryMethod): boolean {
  return method === 'paczkomat' || method === 'kurier';
}
