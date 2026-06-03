/**
 * Server-only InPost ShipX client. Created per request so it reads the current
 * Workers env (mirrors `getStripe()` / `getSupabaseAdmin()`). Thin `fetch`
 * wrapper that injects the base URL and the Bearer token.
 *
 * Base URL is `INPOST_API_URL` — point it at the sandbox
 * (`https://sandbox-api-shipx-pl.easypack24.net`) or production
 * (`https://api-shipx-pl.easypack24.net`).
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { ShipmentPayload } from './shipx';

/** Minimal shape of a ShipX shipment we read back after creation. */
export type ShipxShipment = {
  id: number | string;
  status: string;
  tracking_number: string | null;
  service?: string;
  [key: string]: unknown;
};

export interface InPostClient {
  createShipment(payload: ShipmentPayload): Promise<ShipxShipment>;
  getShipment(id: string): Promise<ShipxShipment>;
  /** A6 PDF label bytes for a confirmed shipment. */
  getLabelPdf(id: string): Promise<ArrayBuffer>;
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
      throw new Error(`ShipX ${init?.method ?? 'GET'} ${path} → ${res.status}: ${detail.slice(0, 500)}`);
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
    async getLabelPdf(id) {
      const res = await request(`/v1/shipments/${id}/label?type=A6&format=pdf`, {
        headers: { Accept: 'application/pdf' },
      });
      return await res.arrayBuffer();
    },
  };
}
