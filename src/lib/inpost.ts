/**
 * Server-only InPost ShipX client. Created per request so it reads the current
 * Workers env (mirrors `getStripe()` / `getSupabaseAdmin()`). Thin `fetch`
 * wrapper that injects the base URL and the Bearer token.
 *
 * Base URL is `INPOST_API_URL` ÔÇö point it at the sandbox
 * (`https://sandbox-api-shipx-pl.easypack24.net`) or production
 * (`https://api-shipx-pl.easypack24.net`).
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { ShipxApiError } from './shipx-errors';
import type { ShipmentPayload, DispatchOrderPayload } from './shipx';

/** Minimal shape of a ShipX shipment we read back after creation. */
export type ShipxShipment = {
  id: number | string;
  status: string;
  tracking_number: string | null;
  service?: string;
  offers?: Array<{ id: number | string; status?: string; service?: { id?: string } }>;
  selected_offer?: { id: number | string } | null;
  /** ISO timestamp — used to pick the oldest match when adopting by reference. */
  created_at?: string;
  /** Echoed back by ShipX — verified client-side against the requested filter
   *  before adoption (see `findShipmentsByReference`); never trusted blindly. */
  reference?: string;
  [key: string]: unknown;
};

/** Minimal shape of a ShipX dispatch order (courier pickup scheduling). */
export type ShipxDispatchOrder = {
  id: number | string;
  status: string;
  deadline_time: string;
  [key: string]: unknown;
};

export interface InPostClient {
  createShipment(payload: ShipmentPayload): Promise<ShipxShipment>;
  getShipment(id: string): Promise<ShipxShipment>;
  /** Look up existing shipments by `reference` (page 1 only) — used to adopt a
   *  shipment from a prior create call whose DB save failed, instead of duplicating it.
   *  Results are filtered client-side to an exact `reference` match: the upstream
   *  `?reference=` query param is never trusted blindly (an ignored/fuzzy filter
   *  could otherwise return the org's unrelated page-1 shipments, or the returns
   *  flow's `return:<id>` reference, causing the wrong shipment to be adopted). */
  findShipmentsByReference(reference: string): Promise<ShipxShipment[]>;
  /** A6 PDF label bytes for a confirmed shipment. */
  getLabelPdf(id: string): Promise<ArrayBuffer>;
  /** Schedule a courier pickup for one or more shipments. */
  createDispatchOrder(payload: DispatchOrderPayload): Promise<ShipxDispatchOrder>;
  /** Buy a prepared offer for a shipment, committing it for label generation. */
  buyShipment(id: string, offerId: number | string): Promise<ShipxShipment>;
}

export function getInPost(): InPostClient {
  const { env } = getCloudflareContext();
  // Normalize first so whitespace-only values don't slip past the guard.
  const apiUrl = env.INPOST_API_URL?.trim();
  const apiToken = env.INPOST_API_TOKEN?.trim();
  const orgId = env.INPOST_ORGANIZATION_ID?.trim();
  if (!apiUrl || !apiToken || !orgId) {
    throw new Error(
      'InPost not configured: INPOST_API_URL / INPOST_API_TOKEN / INPOST_ORGANIZATION_ID missing',
    );
  }
  const baseUrl = apiUrl.replace(/\/+$/, '');
  const authHeader = `Bearer ${apiToken}`;

  async function request(path: string, init?: RequestInit): Promise<Response> {
    // Bound the call so a slow/unreachable upstream can't hang a webhook.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: init?.signal ?? controller.signal,
        headers: {
          Authorization: authHeader,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ShipxApiError(init?.method ?? 'GET', path, res.status, detail.slice(0, 500));
    }
    return res;
  }

  return {
    async createShipment(payload) {
      const res = await request(`/v1/organizations/${orgId}/shipments`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return (await res.json()) as ShipxShipment;
    },
    async getShipment(id) {
      const res = await request(`/v1/shipments/${id}`);
      return (await res.json()) as ShipxShipment;
    },
    async findShipmentsByReference(reference) {
      const res = await request(
        `/v1/organizations/${orgId}/shipments?reference=${encodeURIComponent(reference)}`,
      );
      const body = (await res.json()) as { items?: ShipxShipment[] };
      // Filter client-side on exact match — do not trust ShipX's list filter
      // blindly (see the interface doc comment above for the failure modes).
      return (body.items ?? []).filter((s) => s.reference === reference);
    },
    async getLabelPdf(id) {
      const res = await request(`/v1/shipments/${id}/label?type=A6&format=pdf`, {
        headers: { Accept: 'application/pdf' },
      });
      return await res.arrayBuffer();
    },
    async createDispatchOrder(payload) {
      const res = await request(`/v1/organizations/${orgId}/dispatch_orders`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return (await res.json()) as ShipxDispatchOrder;
    },
    async buyShipment(id, offerId) {
      const offer_id =
        typeof offerId === 'string' && /^\d+$/.test(offerId) ? Number(offerId) : offerId;
      const res = await request(`/v1/shipments/${id}/buy`, {
        method: 'POST',
        body: JSON.stringify({ offer_id }),
      });
      return (await res.json()) as ShipxShipment;
    },
  };
}
