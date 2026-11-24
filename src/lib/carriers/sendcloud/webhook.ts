/**
 * Inbound Sendcloud webhook: signature check + `parcel_status_changed` parsing.
 * Pure apart from WebCrypto. Served by src/app/api/sendcloud/webhook/route.ts.
 */
import { timingSafeEqual } from '@/lib/timing-safe-equal';
import type { SendcloudStatus } from './client';

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `Sendcloud-Signature` is the hex HMAC-SHA256 of the raw request body, keyed
 * with the integration's Webhook Signature Key. Verify against the exact bytes
 * received, before any JSON parsing.
 */
export async function verifySendcloudSignature(
  rawBody: string,
  signature: string | null,
  key: string | undefined,
): Promise<boolean> {
  if (!signature || !key) return false;
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = hex(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(rawBody)));
  return timingSafeEqual(expected, signature.trim().toLowerCase());
}

/** What the app needs from one parcel status change (webhook or poll). */
export type SendcloudParcelUpdate = {
  /** `orders.id` — Sendcloud echoes it back as `order_number`. */
  orderId: string;
  /** Sendcloud shipment the snapshot was read from (the sweep knows it). */
  shipmentId?: string | null;
  /** Sendcloud parcel id (webhooks carry it; it identifies the shipment). */
  parcelId?: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: SendcloudStatus;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a `parcel_status_changed` payload. Returns null for other actions
 * (e.g. `integration_updated`) and for parcels that are not ours — every
 * shipment we announce carries `order_number` = the order's UUID.
 */
export function parseSendcloudWebhook(raw: unknown): SendcloudParcelUpdate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const root = raw as Record<string, unknown>;
  if (root.action !== 'parcel_status_changed') return null;
  const parcel = root.parcel;
  if (typeof parcel !== 'object' || parcel === null) return null;
  const p = parcel as Record<string, unknown>;

  const orderId = typeof p.order_number === 'string' ? p.order_number.trim() : '';
  if (!UUID.test(orderId)) return null;

  const status = (typeof p.status === 'object' && p.status !== null ? p.status : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const parcelId = typeof p.id === 'number' || (typeof p.id === 'string' && p.id.trim()) ? String(p.id).trim() : null;
  return {
    orderId: orderId.toLowerCase(),
    parcelId,
    trackingNumber: text(p.tracking_number),
    trackingUrl: text(p.tracking_url),
    status: {
      id: typeof status.id === 'number' ? status.id : null,
      code: text(status.code),
      message: text(status.message),
    },
  };
}
