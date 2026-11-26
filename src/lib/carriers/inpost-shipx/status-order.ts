/**
 * Ordering of InPost ShipX shipment statuses — pure, no I/O.
 *
 * ShipX webhooks can arrive out of order (a retried `confirmed` after
 * `delivered`), and the webhook token is the only thing authenticating them,
 * so the handler (src/app/api/inpost/webhook/route.ts) only lets a status move
 * forward. Statuses are grouped into coarse stages; moving within a stage is
 * allowed (the mirror keeps the latest detail, e.g. `taken_by_courier` →
 * `out_for_delivery`), moving to an earlier stage is not, and a final status
 * never changes. A status not listed here is unknown and is not stored.
 *
 * Vocabulary: ShipX `GET /v1/statuses` — all 53 names, checked against the
 * live endpoint on 2026-11-26 (the names `orders.delivery_status`
 * uses, src/lib/carriers/status.ts). Same idea as the Sendcloud ranking in
 * src/lib/carriers/sendcloud/status-map.ts.
 */
import { LABEL_READY_STATUS } from '@/lib/carriers/status';

const PRE_LABEL = 0;
const LABEL_READY = 1;
const IN_TRANSIT = 2;
const AT_PICKUP_POINT = 3;
const DELIVERED = 4;
const RETURNED_OR_CANCELED = 5;

const STAGE: Record<string, number> = {
  created: PRE_LABEL,
  offers_prepared: PRE_LABEL,
  offer_selected: PRE_LABEL,

  [LABEL_READY_STATUS]: LABEL_READY,

  dispatched_by_sender: IN_TRANSIT,
  dispatched_by_sender_to_pok: IN_TRANSIT,
  collected_from_sender: IN_TRANSIT,
  taken_by_courier: IN_TRANSIT,
  taken_by_courier_from_pok: IN_TRANSIT,
  taken_by_courier_from_customer_service_point: IN_TRANSIT,
  adopted_at_source_branch: IN_TRANSIT,
  sent_from_source_branch: IN_TRANSIT,
  adopted_at_sorting_center: IN_TRANSIT,
  sent_from_sorting_center: IN_TRANSIT,
  adopted_at_target_branch: IN_TRANSIT,
  out_for_delivery: IN_TRANSIT,
  out_for_delivery_to_address: IN_TRANSIT,
  delay_in_delivery: IN_TRANSIT,
  oversized: IN_TRANSIT,
  redirect_to_box: IN_TRANSIT,
  canceled_redirect_to_box: IN_TRANSIT,
  readdressed: IN_TRANSIT,
  missing: IN_TRANSIT,
  rejected_by_receiver: IN_TRANSIT,
  undelivered: IN_TRANSIT,
  undelivered_wrong_address: IN_TRANSIT,
  undelivered_incomplete_address: IN_TRANSIT,
  undelivered_unknown_receiver: IN_TRANSIT,
  undelivered_cod_cash_receiver: IN_TRANSIT,
  undelivered_no_mailbox: IN_TRANSIT,
  undelivered_not_live_address: IN_TRANSIT,
  undelivered_lack_of_access_letterbox: IN_TRANSIT,
  avizo: IN_TRANSIT,
  courier_avizo_in_customer_service_point: IN_TRANSIT,
  unstack_from_box_machine: IN_TRANSIT,
  unstack_from_customer_service_point: IN_TRANSIT,
  claimed: IN_TRANSIT,
  other: IN_TRANSIT,

  ready_to_pickup: AT_PICKUP_POINT,
  ready_to_pickup_from_pok: AT_PICKUP_POINT,
  ready_to_pickup_from_pok_registered: AT_PICKUP_POINT,
  ready_to_pickup_from_branch: AT_PICKUP_POINT,
  pickup_reminder_sent: AT_PICKUP_POINT,
  pickup_reminder_sent_address: AT_PICKUP_POINT,
  stack_in_box_machine: AT_PICKUP_POINT,
  stack_in_customer_service_point: AT_PICKUP_POINT,
  pickup_time_expired: AT_PICKUP_POINT,
  stack_parcel_pickup_time_expired: AT_PICKUP_POINT,
  stack_parcel_in_box_machine_pickup_time_expired: AT_PICKUP_POINT,

  delivered: DELIVERED,

  returned_to_sender: RETURNED_OR_CANCELED,
  return_pickup_confirmation_to_sender: RETURNED_OR_CANCELED,
  canceled: RETURNED_OR_CANCELED,
};

const FINAL_STAGES = new Set([DELIVERED, RETURNED_OR_CANCELED]);

/** Whether `status` is a ShipX status this app knows how to order. */
export function isKnownShipxStatus(status: string): boolean {
  return Object.prototype.hasOwnProperty.call(STAGE, status);
}

/** Whether `status` is final (delivered / returned / canceled). */
export function isFinalShipxStatus(status: string | null | undefined): boolean {
  return !!status && isKnownShipxStatus(status) && FINAL_STAGES.has(STAGE[status]);
}

/**
 * Whether `next` may replace the stored `current` status. Unknown `next` → no.
 * An empty or unrecognised `current` (legacy row) accepts any known status.
 */
export function shouldAdvanceShipxStatus(current: string | null | undefined, next: string): boolean {
  if (!isKnownShipxStatus(next)) return false;
  if (!current || !isKnownShipxStatus(current)) return true;
  if (current === next || isFinalShipxStatus(current)) return false;
  return STAGE[next] >= STAGE[current];
}
