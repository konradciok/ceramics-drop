/**
 * Sendcloud parcel status → the app's `delivery_status` vocabulary (ShipX
 * status names, src/lib/carriers/status.ts), so the account page, admin queue
 * and customer emails keep one code path.
 *
 * Matched on the v3 `code` first, then the status `message` (both normalised),
 * then the numeric `id` webhooks carry. Sendcloud publishes only part of its id
 * table, so ids are the last resort; anything unrecognised maps to null and
 * leaves the stored status alone (the caller logs it).
 */
import { LABEL_READY_STATUS } from '@/lib/carriers/status';
import type { SendcloudStatus } from './client';

export const IN_TRANSIT_STATUS = 'taken_by_courier';
export const READY_FOR_PICKUP_STATUS = 'ready_to_pickup';
export const DELIVERED_STATUS = 'delivered';
export const RETURNED_STATUS = 'returned_to_sender';
export const CANCELED_STATUS = 'canceled';

/** Normalised code/message → app status. */
const BY_TEXT: Record<string, string> = {
  'ready to send': LABEL_READY_STATUS,
  announced: LABEL_READY_STATUS,
  'en route to sorting center': IN_TRANSIT_STATUS,
  'being sorted': IN_TRANSIT_STATUS,
  sorted: IN_TRANSIT_STATUS,
  'not sorted': IN_TRANSIT_STATUS,
  'parcel en route': IN_TRANSIT_STATUS,
  'driver en route': IN_TRANSIT_STATUS,
  'shipment picked up by driver': IN_TRANSIT_STATUS,
  'delivery delayed': IN_TRANSIT_STATUS,
  'delivery attempt failed': IN_TRANSIT_STATUS,
  'awaiting customer pickup': READY_FOR_PICKUP_STATUS,
  'shipment collected by customer': DELIVERED_STATUS,
  delivered: DELIVERED_STATUS,
  'returned to sender': RETURNED_STATUS,
  cancelled: CANCELED_STATUS,
  canceled: CANCELED_STATUS,
  'cancelled upstream': CANCELED_STATUS,
};

/** Webhook status ids (Sendcloud v2 table; 1000 = Ready to send is confirmed by the v3 cancel docs). */
const BY_ID: Record<number, string> = {
  1000: LABEL_READY_STATUS,
  1: LABEL_READY_STATUS,
  3: IN_TRANSIT_STATUS,
  4: IN_TRANSIT_STATUS,
  5: IN_TRANSIT_STATUS,
  6: IN_TRANSIT_STATUS,
  7: IN_TRANSIT_STATUS,
  22: IN_TRANSIT_STATUS,
  91: IN_TRANSIT_STATUS,
  92: IN_TRANSIT_STATUS,
  12: READY_FOR_PICKUP_STATUS,
  11: DELIVERED_STATUS,
  93: DELIVERED_STATUS,
  2000: CANCELED_STATUS,
};

function normalise(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
  return t.length > 0 ? t : null;
}

export function mapSendcloudStatus(status: SendcloudStatus | null | undefined): string | null {
  if (!status) return null;
  for (const text of [normalise(status.code), normalise(status.message)]) {
    if (text && BY_TEXT[text]) return BY_TEXT[text];
  }
  return typeof status.id === 'number' ? (BY_ID[status.id] ?? null) : null;
}

const RANK: Record<string, number> = {
  created: 0,
  [LABEL_READY_STATUS]: 1,
  [IN_TRANSIT_STATUS]: 2,
  [READY_FOR_PICKUP_STATUS]: 3,
  [DELIVERED_STATUS]: 4,
  [RETURNED_STATUS]: 5,
  [CANCELED_STATUS]: 5,
};

const FINAL = new Set([DELIVERED_STATUS, RETURNED_STATUS, CANCELED_STATUS]);

/**
 * Whether `next` may replace `current`. Webhooks arrive out of order and a
 * poll can race one, so status only moves forward; a final status
 * (delivered / returned / canceled) never changes again.
 */
export function shouldAdvanceStatus(current: string | null | undefined, next: string): boolean {
  if (!current) return true;
  if (current === next || FINAL.has(current)) return false;
  return (RANK[next] ?? -1) > (RANK[current] ?? -1);
}

/** Whether a status means a label exists and the parcel is not lost to a cancel/return. */
export function isLabelReadyOrLater(status: string | null | undefined): boolean {
  if (!status) return false;
  const rank = RANK[status];
  return rank !== undefined && rank >= RANK[LABEL_READY_STATUS] && status !== RETURNED_STATUS && status !== CANCELED_STATUS;
}

/** Statuses after which no further poll is needed. */
export function isFinalStatus(status: string | null | undefined): boolean {
  return !!status && FINAL.has(status);
}
