/**
 * Server-only Sendcloud API v3 client — a thin `fetch` wrapper (no SDK; runs
 * on Cloudflare Workers). HTTP Basic auth with the integration's public key as
 * username and secret key as password. API v3 only: v2 "create parcel" is
 * closed to accounts created after April 2026.
 *
 * Base URL defaults to https://panel.sendcloud.sc/api/v3; SENDCLOUD_API_URL
 * overrides it (tests, a future regional host).
 */
import { SendcloudApiError, SendcloudConfigError } from './errors';
import type { SendcloudAnnounceRequest } from './payload';
import type { SendcloudServicePoint } from './service-points';

export const SENDCLOUD_DEFAULT_API_URL = 'https://panel.sendcloud.sc/api/v3';

/** Sendcloud parcel status as v3 returns it (`code`) or a webhook sends it (`id`). */
export type SendcloudStatus = { id?: number | null; code?: string | null; message?: string | null };

export type SendcloudParcel = {
  id: number | string;
  status?: SendcloudStatus | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  [key: string]: unknown;
};

export type SendcloudShipment = {
  id: string;
  order_number?: string | null;
  external_reference_id?: string | null;
  parcels?: SendcloudParcel[];
  [key: string]: unknown;
};

export interface SendcloudClient {
  /**
   * `POST /shipments/announce` (synchronous, label included). A repeated
   * `external_reference_id` answers 409 with the existing shipment, which is
   * returned as a success — that is how a webhook replay adopts it.
   */
  announceShipment(body: SendcloudAnnounceRequest): Promise<{ shipment: SendcloudShipment; existing: boolean }>;
  getShipment(id: string): Promise<SendcloudShipment>;
  /** `GET /parcels/{id}/documents/label` as an A6 PDF. */
  getParcelLabelPdf(parcelId: string): Promise<ArrayBuffer>;
  /** `POST /shipments/{id}/cancel` — 200 cancelled or 202 queued both count as done. */
  cancelShipment(id: string): Promise<void>;
  /** `GET /service-points/{id}` (Service Points API v3); null when Sendcloud does not know the id. */
  getServicePoint(id: string): Promise<SendcloudServicePoint | null>;
}

export function sendcloudFromEnv(env: CloudflareEnv): SendcloudClient {
  const publicKey = env.SENDCLOUD_PUBLIC_KEY?.trim();
  const secretKey = env.SENDCLOUD_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) {
    throw new SendcloudConfigError('not_configured', 'SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY missing');
  }
  const baseUrl = (env.SENDCLOUD_API_URL?.trim() || SENDCLOUD_DEFAULT_API_URL).replace(/\/+$/, '');
  const authHeader = `Basic ${btoa(`${publicKey}:${secretKey}`)}`;

  /**
   * One call, bounded end to end: the abort timer stays armed until `read`
   * has consumed the body (fetch resolves on headers, so a stalled body would
   * otherwise outlive the bound — Stripe allows ~30 s, Sendcloud's own
   * webhook 10 s, and the sweep works through its batch sequentially).
   */
  async function request<T>(
    path: string,
    init: RequestInit & { okStatuses?: number[] },
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    const { okStatuses = [], ...fetchInit } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...fetchInit,
        signal: fetchInit.signal ?? controller.signal,
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          ...(fetchInit.body ? { 'Content-Type': 'application/json' } : {}),
          ...(fetchInit.headers ?? {}),
        },
      });
      if (!res.ok && !okStatuses.includes(res.status)) {
        const detail = await res.text().catch(() => '');
        throw new SendcloudApiError(fetchInit.method ?? 'GET', path, res.status, detail.slice(0, 500));
      }
      return await read(res);
    } finally {
      clearTimeout(timer);
    }
  }

  async function shipmentFrom(res: Response): Promise<SendcloudShipment> {
    const body = (await res.json()) as { data?: SendcloudShipment };
    if (!body.data?.id) throw new Error('Sendcloud: shipment response without data.id');
    return body.data;
  }

  return {
    async announceShipment(body) {
      return request(
        '/shipments/announce',
        { method: 'POST', body: JSON.stringify(body), okStatuses: [409] },
        async (res) => ({ shipment: await shipmentFrom(res), existing: res.status === 409 }),
      );
    },
    async getShipment(id) {
      return request(`/shipments/${encodeURIComponent(id)}`, {}, shipmentFrom);
    },
    async getParcelLabelPdf(parcelId) {
      return request(
        `/parcels/${encodeURIComponent(parcelId)}/documents/label?paper_size=A6`,
        { headers: { Accept: 'application/pdf' } },
        (res) => res.arrayBuffer(),
      );
    },
    async cancelShipment(id) {
      await request(`/shipments/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, async () => undefined);
    },
    async getServicePoint(id) {
      return request(`/service-points/${encodeURIComponent(id)}`, { okStatuses: [404] }, async (res) => {
        if (res.status === 404) return null;
        const body = (await res.json()) as { data?: SendcloudServicePoint };
        return body.data ?? null;
      });
    },
  };
}
