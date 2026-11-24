import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendcloudFromEnv, SENDCLOUD_DEFAULT_API_URL } from './client';
import { SendcloudApiError, SendcloudConfigError } from './errors';
import type { SendcloudAnnounceRequest } from './payload';

const env = { SENDCLOUD_PUBLIC_KEY: 'pub', SENDCLOUD_SECRET_KEY: 'sec' } as unknown as CloudflareEnv;
const shipment = { id: 'shp-1', parcels: [{ id: 77, status: { code: 'READY_TO_SEND', message: 'Ready to send' } }] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('sendcloudFromEnv', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fails closed without keys', () => {
    expect(() => sendcloudFromEnv({} as CloudflareEnv)).toThrow(SendcloudConfigError);
    expect(() => sendcloudFromEnv({ SENDCLOUD_PUBLIC_KEY: 'pub', SENDCLOUD_SECRET_KEY: '  ' } as unknown as CloudflareEnv)).toThrow(/not_configured/);
  });

  it('announces with Basic auth against the v3 base URL', async () => {
    fetchMock.mockResolvedValue(json({ data: shipment }, 201));
    const result = await sendcloudFromEnv(env).announceShipment({ order_number: 'o1' } as SendcloudAnnounceRequest);

    expect(result).toEqual({ shipment, existing: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SENDCLOUD_DEFAULT_API_URL}/shipments/announce`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('pub:sec')}`);
    expect(JSON.parse(init.body as string)).toEqual({ order_number: 'o1' });
  });

  it('treats a 409 (repeated external_reference_id) as the existing shipment', async () => {
    fetchMock.mockResolvedValue(json({ data: shipment }, 409));
    const result = await sendcloudFromEnv(env).announceShipment({} as SendcloudAnnounceRequest);
    expect(result).toEqual({ shipment, existing: true });
  });

  it('throws SendcloudApiError with the first error code on other failures', async () => {
    fetchMock.mockResolvedValue(json({ errors: [{ code: 'invalid', detail: 'to_service_point is invalid', status: '400' }] }, 400));
    const err = await sendcloudFromEnv(env).announceShipment({} as SendcloudAnnounceRequest).catch((e) => e);
    expect(err).toBeInstanceOf(SendcloudApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid');
    expect(err.message).toContain('to_service_point is invalid');
  });

  it('honours SENDCLOUD_API_URL and fetches the A6 label as PDF', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }));
    const client = sendcloudFromEnv({ ...env, SENDCLOUD_API_URL: 'https://sc.test/api/v3/' } as CloudflareEnv);
    const pdf = await client.getParcelLabelPdf('77');

    expect(new Uint8Array(pdf)).toEqual(new Uint8Array([37, 80, 68, 70]));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sc.test/api/v3/parcels/77/documents/label?paper_size=A6');
    expect((init.headers as Record<string, string>).Accept).toBe('application/pdf');
  });

  it('cancels and reads shipments by id', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: { status: 'cancelled' } }, 200))
      .mockResolvedValueOnce(json({ data: shipment }));
    const client = sendcloudFromEnv(env);
    await client.cancelShipment('shp-1');
    await expect(client.getShipment('shp-1')).resolves.toEqual(shipment);
    expect(fetchMock.mock.calls[0][0]).toBe(`${SENDCLOUD_DEFAULT_API_URL}/shipments/shp-1/cancel`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${SENDCLOUD_DEFAULT_API_URL}/shipments/shp-1`);
  });

  it('reads a service point, and answers null for an id Sendcloud does not know', async () => {
    const point = { id: 10544, carrier: { code: 'inpost_es' } };
    fetchMock.mockResolvedValueOnce(json({ data: point })).mockResolvedValueOnce(json({ errors: [{ code: 'not_found' }] }, 404));
    const client = sendcloudFromEnv(env);
    await expect(client.getServicePoint('10544')).resolves.toEqual(point);
    await expect(client.getServicePoint('999')).resolves.toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe(`${SENDCLOUD_DEFAULT_API_URL}/service-points/10544`);
  });

  it('throws on a server-side failure of the point lookup', async () => {
    fetchMock.mockResolvedValue(json({}, 503));
    await expect(sendcloudFromEnv(env).getServicePoint('1')).rejects.toBeInstanceOf(SendcloudApiError);
  });
});
