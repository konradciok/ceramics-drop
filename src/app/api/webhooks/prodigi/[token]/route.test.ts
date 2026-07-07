import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHandle } = vi.hoisted(() => ({ mockHandle: vi.fn() }));
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: { PRODIGI_CALLBACK_TOKEN: 'tok_good' } }),
}));
vi.mock('@/server/prodigi/callbacks', () => ({ handleProdigiCallback: mockHandle }));

import { POST } from './route';

function req(token: string, body: string = JSON.stringify({ id: 'evt-1', type: 't', data: {} })) {
  return [
    new Request(`http://localhost/api/webhooks/prodigi/${token}`, { method: 'POST', body }),
    { params: Promise.resolve({ token }) },
  ] as const;
}

describe('POST /api/webhooks/prodigi/[token]', () => {
  beforeEach(() => {
    mockHandle.mockReset();
    mockHandle.mockResolvedValue({ status: 200, message: 'OK' });
  });

  it('rejects an invalid token with 401 before touching the handler', async () => {
    const res = await POST(...req('tok_bad'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await POST(...req('tok_good', 'not-json'));
    expect(res.status).toBe(400);
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it('delegates a valid callback and returns the handler status', async () => {
    const res = await POST(...req('tok_good'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'OK' });
    expect(mockHandle).toHaveBeenCalledTimes(1);
  });

  it('maps handler failures onto the { error } API shape', async () => {
    mockHandle.mockResolvedValue({ status: 500, message: 'No local order for Prodigi order pr_1' });
    const res = await POST(...req('tok_good'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'No local order for Prodigi order pr_1' });
  });
});
