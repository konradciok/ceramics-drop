import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

const KEY = 'webhook-signature-key-123';
const mocks = vi.hoisted(() => ({ applySendcloudParcelUpdate: vi.fn(), getLabelPdf: vi.fn(), getShipment: vi.fn(), captureException: vi.fn() }));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: { SENDCLOUD_WEBHOOK_SIGNATURE_KEY: 'webhook-signature-key-123' } }),
}));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ tag: 'supabase' }) }));
vi.mock('@/lib/carriers', () => ({
  carriersFromEnv: () => () => ({ getLabelPdf: mocks.getLabelPdf }),
}));
vi.mock('@/lib/carriers/sendcloud/client', () => ({ sendcloudFromEnv: () => ({ getShipment: mocks.getShipment }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }));
vi.mock('@/server/sendcloud-parcel-update', () => ({ applySendcloudParcelUpdate: mocks.applySendcloudParcelUpdate }));

import { POST } from './route';

const ORDER_ID = '0b6f7c1e-1111-4222-8333-444455556666';
const event = {
  action: 'parcel_status_changed',
  timestamp: 1764000000,
  parcel: { id: 77, order_number: ORDER_ID, tracking_number: 'ESTRK1', status: { id: 11, message: 'Delivered' } },
};

function req(body: string, signature?: string) {
  return new Request('https://anna-ciok.studio/api/sendcloud/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature ? { 'Sendcloud-Signature': signature } : {}) },
    body,
  });
}
const sign = (body: string) => createHmac('sha256', KEY).update(body).digest('hex');

describe('POST /api/sendcloud/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applySendcloudParcelUpdate.mockResolvedValue('applied');
  });

  it('rejects an unsigned or wrongly signed delivery with 401', async () => {
    const body = JSON.stringify(event);
    expect((await POST(req(body))).status).toBe(401);
    expect((await POST(req(body, sign(`${body}x`)))).status).toBe(401);
    expect(mocks.applySendcloudParcelUpdate).not.toHaveBeenCalled();
  });

  it('applies a signed parcel status change', async () => {
    const body = JSON.stringify(event);
    const res = await POST(req(body, sign(body)));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, outcome: 'applied' });
    expect(mocks.applySendcloudParcelUpdate).toHaveBeenCalledWith(
      { supabase: { tag: 'supabase' }, getLabelPdf: expect.any(Function), getShipment: expect.any(Function) },
      { orderId: ORDER_ID, parcelId: '77', trackingNumber: 'ESTRK1', trackingUrl: null, status: { id: 11, code: null, message: 'Delivered' } },
    );
  });

  it('acknowledges events it does not handle', async () => {
    const body = JSON.stringify({ action: 'integration_updated' });
    const res = await POST(req(body, sign(body)));
    expect(res.status).toBe(200);
    expect(mocks.applySendcloudParcelUpdate).not.toHaveBeenCalled();
  });

  it('answers 400 to signed non-JSON and 500 when the update fails (so Sendcloud retries)', async () => {
    expect((await POST(req('not json', sign('not json')))).status).toBe(400);

    mocks.applySendcloudParcelUpdate.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = JSON.stringify(event);
    expect((await POST(req(body, sign(body)))).status).toBe(500);
    expect(mocks.captureException).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it('refuses an oversized body before checking the signature (413)', async () => {
    const huge = JSON.stringify({ ...event, pad: 'x'.repeat(300_000) });
    expect((await POST(req(huge, sign(huge)))).status).toBe(413);
    expect(mocks.applySendcloudParcelUpdate).not.toHaveBeenCalled();
  });
});
