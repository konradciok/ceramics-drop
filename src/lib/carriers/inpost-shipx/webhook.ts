/**
 * Inbound InPost ShipX status webhook parsing — pure, no I/O.
 * Served by src/app/api/inpost/webhook/route.ts.
 */
import { LABEL_READY_STATUS } from '@/lib/carriers/status';

export type ShipxStatusEvent = {
  shipmentId: string;
  status: string;
  trackingNumber: string | null;
};

/**
 * Parse an inbound ShipX status webhook. The payload may carry the fields at the
 * top level or nested under `payload` — read defensively and return null if the
 * essentials (shipment id + status) are missing.
 *
 * Also handles `{ event: 'shipment_confirmed', payload: { shipment_id, tracking_number } }`
 * — confirmation webhooks carry no `status` field; the event name implies `LABEL_READY_STATUS`.
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

  let status = nested.status ?? root.status;
  if (typeof status !== 'string' || status.length === 0) {
    // No status field — check for a recognized event name as a fallback.
    if (root.event === 'shipment_confirmed') {
      status = LABEL_READY_STATUS;
    } else {
      return null;
    }
  }

  const tracking = nested.tracking_number ?? root.tracking_number ?? null;
  return {
    shipmentId: String(idRaw),
    status: status as string,
    trackingNumber: typeof tracking === 'string' && tracking.length > 0 ? tracking : null,
  };
}
