/**
 * Checkout delivery validation — pure, no I/O, carrier-neutral.
 *
 * `validateDelivery` turns the raw checkout body into a typed delivery
 * selection (mirrors `validateCart`'s discriminated-union style).
 */
import { CHECKOUT_DELIVERY_METHODS, type DeliveryMethod } from '@/lib/pricing';
import type { DeliveryAddress, DeliveryContact, ValidateDeliveryResult } from './types';

// Customer-selectable methods only: studio pickup is refused while it is off.
const METHODS = CHECKOUT_DELIVERY_METHODS;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** Resolve the raw checkout delivery payload to a typed, validated selection. */
export function validateDelivery(raw: unknown): ValidateDeliveryResult {
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
    const target_point = str(body.target_point);
    if (!target_point) return { ok: false, reason: 'missing_target_point' };
    return { ok: true, delivery: { method: m, contact, target_point } };
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
    return { ok: true, delivery: { method: m, contact, address } };
  }

  // odbior — no shipment, no address/locker.
  return { ok: true, delivery: { method: m, contact } };
}

/** Whether a delivery method results in a carrier shipment (odbior does not). */
export function needsShipment(method: DeliveryMethod): boolean {
  return method === 'paczkomat' || method === 'kurier';
}
