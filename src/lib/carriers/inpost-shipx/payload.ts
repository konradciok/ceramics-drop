/**
 * InPost ShipX payload builders — pure, no I/O.
 *
 * `buildShipmentPayload` turns a paid order into the ShipX create-shipment
 * request body; `buildDispatchOrderPayload` schedules a courier pickup;
 * `pickBuyableOffer` chooses the offer to buy. Checkout validation lives in
 * src/lib/delivery/validate.ts, the webhook parser in ./webhook.ts.
 */
import type { DeliveryAddress, DeliveryContact } from '@/lib/delivery/types';
import { needsShipment } from '@/lib/delivery/validate';
import type { OrderForShipment } from '@/lib/carriers/types';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** ShipX service identifiers per method. */
export const SHIPX_SERVICE: Record<'paczkomat' | 'kurier', string> = {
  paczkomat: 'inpost_locker_standard',
  kurier: 'inpost_courier_standard',
};

/** How the sender hands the parcel to InPost (configurable per studio logistics). */
export const SENDING_METHOD: Record<'paczkomat' | 'kurier', string> = {
  paczkomat: 'parcel_locker', // studio drops the parcel at a Paczkomat
  kurier: 'dispatch_order', //   courier collects from the studio
};

/**
 * Single default parcel size for every shipment (no per-product sizing).
 * Lockers take a template; courier takes the equivalent dimensions + weight.
 */
export const DEFAULT_LOCKER_PARCEL = { template: 'medium' };
export const DEFAULT_COURIER_PARCEL = {
  dimensions: { length: '380', width: '640', height: '190', unit: 'mm' },
  weight: { amount: '2', unit: 'kg' },
};

/** Offer statuses that can still be passed to `buyShipment`. */
const BUYABLE_OFFER_STATUSES = new Set(['available', 'selected']);

function isBuyableOffer(offer: { id?: number | string; status?: string } | null | undefined): boolean {
  if (offer?.id === undefined || offer.id === null) return false;
  const status = offer.status?.trim().toLowerCase();
  return !!status && BUYABLE_OFFER_STATUSES.has(status);
}

/**
 * Pick the offer id to pass to `buyShipment`. Returns the id as a string, or
 * null when no buyable offer exists. Priority: `selected_offer` first (when
 * still buyable), then the first offer with status `'available'` or `'selected'`.
 */
export function pickBuyableOffer(shipment: {
  offers?: Array<{ id: number | string; status?: string; service?: { id?: string } }>;
  selected_offer?: { id: number | string; status?: string } | null;
}): string | null {
  if (isBuyableOffer(shipment.selected_offer)) {
    return String(shipment.selected_offer!.id);
  }
  const found = (shipment.offers ?? []).find((o) => isBuyableOffer(o));
  return found !== undefined ? String(found.id) : null;
}

// ── Dispatch orders (courier pickup scheduling) ──────────────────────────────

export type DispatchOrderPayload = {
  name: string;
  shipment_ids: string[];
  /** Latest courier arrival time: "YYYY-MM-DD HH:MM" in Europe/Warsaw. */
  deadline_time: string;
  comments?: string;
};

/**
 * Build a dispatch order payload that schedules courier pickup of `shipmentId`.
 * Deadline is set to the next calendar day at 18:00 Warsaw time, computed from
 * the `now` argument (injectable for deterministic tests).
 */
export function buildDispatchOrderPayload(shipmentId: string, now: Date): DispatchOrderPayload {
  const warsawDateStr = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [year, month, day] = warsawDateStr.split('-').map(Number);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDayStr = nextDay.toISOString().slice(0, 10);
  return {
    name: `Odbiór kurierski ${nextDayStr}`,
    shipment_ids: [shipmentId],
    deadline_time: `${nextDayStr} 18:00`,
  };
}

export type ShipmentPayload = {
  receiver?: DeliveryContact & { address?: DeliveryAddress };
  sender?: DeliveryContact & { address?: DeliveryAddress };
  is_return?: boolean;
  parcels: unknown[];
  custom_attributes: Record<string, string>;
  service: string;
  reference: string;
};

/**
 * Build the ShipX `POST /v1/organizations/{id}/shipments` body for a paid order.
 * Throws for `odbior` (no shipment) — callers gate on `needsShipment` first.
 */
export function buildShipmentPayload(order: OrderForShipment): ShipmentPayload {
  const method = order.delivery_method;
  if (!needsShipment(method)) {
    throw new Error(`buildShipmentPayload called for non-shipment method: ${method}`);
  }
  const m = method as 'paczkomat' | 'kurier';

  // Defense-in-depth: validateDelivery guarantees these at checkout, but never
  // build a half-empty ShipX payload. Use str() so whitespace-only persisted
  // values (e.g. '   ') and partial addresses are rejected too, not just nulls.
  const firstName = str(order.receiver_first_name);
  const lastName = str(order.receiver_last_name);
  const email = str(order.email);
  const phone = str(order.receiver_phone);
  if (!firstName || !lastName || !email || !phone) {
    throw new Error(`buildShipmentPayload: incomplete receiver for order ${order.id}`);
  }

  const targetPoint = m === 'paczkomat' ? str(order.inpost_target_point) : null;
  if (m === 'paczkomat' && !targetPoint) {
    throw new Error(`buildShipmentPayload: missing target_point for order ${order.id}`);
  }

  let address: DeliveryAddress | undefined;
  if (m === 'kurier') {
    const a = order.shipping_address;
    const street = str(a?.street);
    const building_number = str(a?.building_number);
    const city = str(a?.city);
    const post_code = str(a?.post_code);
    if (!street || !building_number || !city || !post_code) {
      throw new Error(`buildShipmentPayload: missing address for order ${order.id}`);
    }
    address = { street, building_number, city, post_code, country_code: str(a?.country_code) ?? 'PL' };
  }

  const receiver: DeliveryContact & { address?: DeliveryAddress } = {
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
  };

  if (m === 'paczkomat') {
    return {
      receiver,
      parcels: [DEFAULT_LOCKER_PARCEL],
      custom_attributes: {
        sending_method: SENDING_METHOD.paczkomat,
        target_point: targetPoint as string,
      },
      service: SHIPX_SERVICE.paczkomat,
      reference: order.id,
    };
  }

  // kurier
  receiver.address = address;
  return {
    receiver,
    parcels: [DEFAULT_COURIER_PARCEL],
    custom_attributes: { sending_method: SENDING_METHOD.kurier },
    service: SHIPX_SERVICE.kurier,
    reference: order.id,
  };
}
