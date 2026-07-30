import { describe, it, expect, vi } from 'vitest';
import { SITE_URL } from '@/lib/site';
import { buildMetaPurchasePayload, parseMetaCapiErrorBody, sendMetaPurchase, type MetaPurchaseInput } from './meta-capi';

const input = (): MetaPurchaseInput => ({
  eventId: 'purchase-pi_1',
  eventTimeSecs: 1_680_000_000,
  eventSourceUrl: 'https://anna-ciok.studio/koszyk/return',
  userData: { em: ['HASH_EM'], client_ip_address: '1.2.3.4', client_user_agent: 'UA', fbp: 'fb.1.1.A', fbc: null },
  value: 318,
  currency: 'PLN',
  contentIds: ['k01', 'v01'],
  contents: [{ id: 'k01', quantity: 1, item_price: 90 }, { id: 'v01', quantity: 1, item_price: 210 }],
  numItems: 2,
  orderId: 'pi_1',
});

describe('buildMetaPurchasePayload', () => {
  it('builds a single Purchase event with dedup id and no null fbc key', () => {
    const payload = buildMetaPurchasePayload(input());
    expect(payload.data).toHaveLength(1);
    const e = payload.data[0];
    expect(e.event_name).toBe('Purchase');
    expect(e.event_id).toBe('purchase-pi_1');
    expect(e.action_source).toBe('website');
    expect(e.user_data.fbc).toBeUndefined(); // null pruned
    expect(e.user_data.fbp).toBe('fb.1.1.A');
    expect(e.custom_data).toMatchObject({ currency: 'PLN', value: 318, num_items: 2, order_id: 'pi_1' });
    expect(e.custom_data.contents).toHaveLength(2);
  });

  it('includes event_source_url when provided', () => {
    const e = buildMetaPurchasePayload(input()).data[0];
    expect(e.event_source_url).toBe('https://anna-ciok.studio/koszyk/return');
  });

  it('falls back to store homepage when eventSourceUrl is null', () => {
    const e = buildMetaPurchasePayload({ ...input(), eventSourceUrl: null }).data[0];
    expect(e.event_source_url).toBe(SITE_URL);
  });
});

describe('sendMetaPurchase', () => {
  it('POSTs to the graph endpoint and reports ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    const res = await sendMetaPurchase(
      { pixelId: 'PIX', accessToken: 'TOK' },
      input(),
      fetchImpl,
    );
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://graph.facebook.com/');
    expect(url).toContain('/PIX/events');
    expect(url).not.toContain('access_token'); // F-21: token no longer in URL
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer TOK'); // token in header, not URL or body
    expect(JSON.parse(init.body)).not.toHaveProperty('access_token');
    expect(JSON.parse(init.body)).not.toHaveProperty('test_event_code');
  });

  it('includes test_event_code when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    await sendMetaPurchase({ pixelId: 'PIX', accessToken: 'TOK', testEventCode: 'TEST123' }, input(), fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).test_event_code).toBe('TEST123');
  });

  it('bounds the request with an 8s abort signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    await sendMetaPurchase({ pixelId: 'PIX', accessToken: 'TOK' }, input(), fetchImpl);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('captures the response body on a non-ok response, so the real Meta error is diagnosable', async () => {
    const errorJson = '{"error":{"message":"Invalid OAuth access token","type":"OAuthException","code":190}}';
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => errorJson });
    const res = await sendMetaPurchase({ pixelId: 'PIX', accessToken: 'TOK' }, input(), fetchImpl);
    expect(res).toEqual({ ok: false, status: 400, errorBody: errorJson });
  });

  it('does not blow up when the response body cannot be read', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('stream already consumed');
      },
    });
    const res = await sendMetaPurchase({ pixelId: 'PIX', accessToken: 'TOK' }, input(), fetchImpl);
    expect(res).toEqual({ ok: false, status: 500, errorBody: undefined });
  });
});

describe('parseMetaCapiErrorBody', () => {
  it('extracts the stable error fields', () => {
    const body = '{"error":{"message":"Invalid OAuth access token","type":"OAuthException","code":190,"error_subcode":460,"fbtrace_id":"AbCdEf111"}}';
    expect(parseMetaCapiErrorBody(body)).toEqual({
      message: 'Invalid OAuth access token',
      type: 'OAuthException',
      code: 190,
      errorSubcode: 460,
    });
  });

  it('ignores fbtrace_id — two responses that only differ by trace id parse identically', () => {
    const bodyFor = (fbtraceId: string) =>
      `{"error":{"message":"Invalid OAuth access token","type":"OAuthException","code":190,"error_subcode":460,"fbtrace_id":"${fbtraceId}"}}`;
    expect(parseMetaCapiErrorBody(bodyFor('trace-one'))).toEqual(parseMetaCapiErrorBody(bodyFor('trace-two')));
  });

  it('returns an empty object for missing, malformed, or shape-less bodies', () => {
    expect(parseMetaCapiErrorBody(undefined)).toEqual({});
    expect(parseMetaCapiErrorBody('not json')).toEqual({});
    expect(parseMetaCapiErrorBody('{"unexpected":"shape"}')).toEqual({});
  });
});
