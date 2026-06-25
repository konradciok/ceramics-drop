/**
 * InPost ShipX domain logic — pure, no I/O.
 *
 * Splits into: (1) `validateDelivery`, which turns the raw checkout body into a
 * typed delivery selection (mirrors `validateCart`'s discriminated-union style),
 * and (2) `buildShipmentPayload`, which turns a paid order into the ShipX
 * create-shipment request body.
 */
import type { DeliveryMethod } from './pricing';

/** Receiver contact collected at checkout. `phone` is required for InPost shipments. */
export type DeliveryContact = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
};

/** Courier address in ShipX shape (also what we persist in `orders.shipping_address`). */
export type DeliveryAddress = {
  street: string;
  building_number: string;
  city: string;
  post_code: string;
  country_code: string;
};

export type DeliverySelection = {
  method: DeliveryMethod;
  contact: DeliveryContact;
  /** Paczkomat code (e.g. 'KRA010') — paczkomat only. */
  target_point?: string;
  /** Courier address — kurier only. */
  address?: DeliveryAddress;
};

export type ValidateDeliveryResult =
  | { ok: true; delivery: DeliverySelection }
  | {
      ok: false;
      reason:
        | 'invalid_method'
        | 'invalid_contact'
        | 'missing_target_point'
        | 'invalid_address';
    };

const METHODS: readonly DeliveryMethod[] = ['paczkomat', 'kurier', 'odbior'];

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

  // Contact: name + email always required; phone required for InPost shipments.
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

/** Whether a delivery method results in an InPost shipment (odbior does not). */
export function needsShipment(method: DeliveryMethod): boolean {
  return method === 'paczkomat' || method === 'kurier';
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

/** ShipX status at which the printable label becomes available. */
export const LABEL_READY_STATUS = 'confirmed';

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

// ── Return shipments ─────────────────────────────────────────────────────────

/** Order fields needed to build a return shipment payload. */
export type OrderForReturn = {
  id: string;
  email: string | null;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  receiver_phone: string | null;
  locale: string | null;
};

/** Studio contact + address used as the receiver on return shipments. */
export type StudioReturnConfig = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: DeliveryAddress;
  /** Optional paczkomat code pre-assigned as the return drop-off target. */
  return_point?: string;
};

/**
 * Build the ShipX create-shipment body for a customer return.
 * Customer is the sender (drops off at `return_point` locker); studio is the receiver.
 * We set sender/receiver explicitly — `is_return: true` 500s on our ShipX org.
 */
export function buildReturnShipmentPayload(
  order: OrderForReturn,
  config: StudioReturnConfig,
): ShipmentPayload {
  const firstName = str(order.receiver_first_name);
  const lastName = str(order.receiver_last_name);
  const email = str(order.email);
  const phone = str(order.receiver_phone);
  const returnPoint = str(config.return_point);
  if (!firstName || !lastName || !email || !phone) {
    throw new Error(`buildReturnShipmentPayload: incomplete customer contact for order ${order.id}`);
  }
  if (!returnPoint) {
    throw new Error(`buildReturnShipmentPayload: return_point required for order ${order.id}`);
  }

  return {
    sender: { first_name: firstName, last_name: lastName, email, phone },
    receiver: {
      first_name: config.first_name,
      last_name: config.last_name,
      email: config.email,
      phone: config.phone,
      address: config.address,
    },
    parcels: [DEFAULT_LOCKER_PARCEL],
    custom_attributes: {
      sending_method: SENDING_METHOD.paczkomat,
      target_point: returnPoint,
    },
    service: SHIPX_SERVICE.paczkomat,
    reference: `return:${order.id}`,
  };
}

export type ShipxStatusEvent = {
  shipmentId: string;
  status: string;
  trackingNumber: string | null;
};

/**
 * Parse an inbound ShipX status webhook. The payload may carry the fields at the
 * top level or nested under `payload` — read defensively and return null if the
 * essentials (shipment id + status) are missing.
 */
export function parseShipxWebhook(raw: unknown): ShipxStatusEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const root = raw as Record<string, unknown>;
  const nested =
    typeof root.payload === 'object' && root.payload !== null
      ? (root.payload as Record<string, unknown>)
      : root;

  const idRaw = nested.shipment_id ?? nested.id ?? root.shipment_id;
  if (idRaw === undefined || idRaw === null || idRaw === '') return null;

  const status = nested.status ?? root.status;
  if (typeof status !== 'string' || status.length === 0) return null;

  const tracking = nested.tracking_number ?? root.tracking_number ?? null;
  return {
    shipmentId: String(idRaw),
    status,
    trackingNumber: typeof tracking === 'string' && tracking.length > 0 ? tracking : null,
  };
}

/** Order fields `buildShipmentPayload` needs (a subset of the `orders` row). */
export type OrderForShipment = {
  id: string;
  delivery_method: DeliveryMethod;
  email: string | null;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  receiver_phone: string | null;
  inpost_target_point: string | null;
  shipping_address: DeliveryAddress | null;
  /** Set once a shipment exists — used to keep creation idempotent. */
  inpost_shipment_id: string | null;
  /** Set once a dispatch order exists — used to retry dispatch when shipment succeeded but dispatch failed. */
  inpost_dispatch_order_id: string | null;
};

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
