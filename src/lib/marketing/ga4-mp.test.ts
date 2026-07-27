import { describe, it, expect, vi } from 'vitest';
import { buildGa4PurchasePayload, sendGa4Purchase, type Ga4PurchaseInput } from './ga4-mp';

const input = (over: Partial<Ga4PurchaseInput> = {}): Ga4PurchaseInput => ({
  clientId: '111.222',
  sessionId: '999',
  transactionId: 'pi_1',
  value: 300,
  shipping: 18,
  currency: 'PLN',
  items: [{ item_id: 'k01', item_name: 'Kubek Nº 1', price: 90, quantity: 1, item_category: 'kubki', item_brand: 'Anna Ciok Ceramics' }],
  userData: { sha256_email_address: 'HASH_EM' },
  appVersion: '0.10.0',
  appGitSha: '8ae90a5',
  ...over,
});

describe('buildGa4PurchasePayload', () => {
  it('builds a purchase event keyed by transaction_id with session stitching', () => {
    const p = buildGa4PurchasePayload(input());
    expect(p.client_id).toBe('111.222');
    expect(p.events[0].name).toBe('purchase');
    expect(p.events[0].params).toMatchObject({
      transaction_id: 'pi_1', value: 300, shipping: 18, currency: 'PLN', session_id: '999',
      app_version: '0.10.0', app_git_sha: '8ae90a5',
    });
    expect(p.user_data).toEqual({ sha256_email_address: 'HASH_EM' });
  });
});

describe('sendGa4Purchase', () => {
  it('skips (returns skipped) when clientId is missing', async () => {
    const fetchImpl = vi.fn();
    const res = await sendGa4Purchase({ measurementId: 'G-X', apiSecret: 'S' }, input({ clientId: null as unknown as string }), fetchImpl);
    expect(res).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs to /mp/collect with measurement_id + api_secret', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    const res = await sendGa4Purchase({ measurementId: 'G-X', apiSecret: 'S' }, input(), fetchImpl);
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://www.google-analytics.com/mp/collect');
    expect(url).toContain('measurement_id=G-X');
    expect(url).toContain('api_secret=S');
    expect(init.method).toBe('POST');
  });

  it('bounds the request with an 8s abort signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    await sendGa4Purchase({ measurementId: 'G-X', apiSecret: 'S' }, input(), fetchImpl);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('captures the response body on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => '{"error":"forbidden"}' });
    const res = await sendGa4Purchase({ measurementId: 'G-X', apiSecret: 'S' }, input(), fetchImpl);
    expect(res).toEqual({ ok: false, status: 403, errorBody: '{"error":"forbidden"}' });
  });
});
