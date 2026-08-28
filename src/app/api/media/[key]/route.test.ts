// Route-level tests for the public site-media GET/HEAD routes, modeled on
// src/app/api/print-assets/[id]/route.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENV = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockHead = vi.fn();
  return {
    PRINT_ASSETS: { get: mockGet, head: mockHead } as
      | { get: typeof mockGet; head: typeof mockHead }
      | undefined,
    mockGet,
    mockHead,
  };
});

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: ENV }),
}));

import { GET, HEAD } from './route';

const VALID_KEY = `${'a'.repeat(64)}.webp`;
const INVALID_KEY = 'not-a-valid-key.webp';
const ETAG = '"media-etag"';

const params = (key: string) => ({ params: Promise.resolve({ key }) });

function buildRequest(key: string, opts: { range?: string; method?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.range) headers.range = opts.range;
  return new Request(`http://localhost/api/media/${key}`, { method: opts.method ?? 'GET', headers });
}

function fakeR2Object(opts: { size?: number; body?: string; httpEtag?: string } = {}) {
  const { size = 1234, body = 'site-media-bytes', httpEtag = ETAG } = opts;
  return {
    body: new Response(body).body,
    size,
    httpEtag,
  };
}

describe('GET /api/media/[key]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ENV.PRINT_ASSETS = { get: ENV.mockGet, head: ENV.mockHead };
    ENV.mockGet.mockReset();
    ENV.mockHead.mockReset();
  });

  it('404 with JSON error on an invalid key', async () => {
    const res = await GET(buildRequest(INVALID_KEY), params(INVALID_KEY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
    expect(ENV.mockHead).not.toHaveBeenCalled();
  });

  it('404 when the R2 object is missing', async () => {
    ENV.mockGet.mockResolvedValue(null);
    const res = await GET(buildRequest(VALID_KEY), params(VALID_KEY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(ENV.mockGet).toHaveBeenCalledWith(`site-media/${VALID_KEY}`);
  });

  it('plain GET happy path: 200, correct content-type, etag, accept-ranges, immutable cache-control, nosniff', async () => {
    ENV.mockGet.mockResolvedValue(fakeR2Object({ size: 4096 }));
    const res = await GET(buildRequest(VALID_KEY), params(VALID_KEY));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('site-media-bytes');
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('content-length')).toBe('4096');
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('valid Range -> 206 with content-range and R2 called with the right offset/length', async () => {
    ENV.mockHead.mockResolvedValue({ size: 1000, httpEtag: ETAG });
    ENV.mockGet.mockResolvedValue(fakeR2Object({ size: 1000, body: 'partial-bytes' }));
    const res = await GET(buildRequest(VALID_KEY, { range: 'bytes=100-199' }), params(VALID_KEY));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('content-length')).toBe('100');
    expect(ENV.mockHead).toHaveBeenCalledWith(`site-media/${VALID_KEY}`);
    expect(ENV.mockGet).toHaveBeenCalledWith(`site-media/${VALID_KEY}`, {
      range: { offset: 100, length: 100 },
    });
  });

  it('unsatisfiable Range -> 416 with content-range: bytes */<size>', async () => {
    ENV.mockHead.mockResolvedValue({ size: 500, httpEtag: ETAG });
    const res = await GET(buildRequest(VALID_KEY, { range: 'bytes=9999-10999' }), params(VALID_KEY));
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */500');
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('malformed Range -> 200 whole file (server ignores the header)', async () => {
    ENV.mockHead.mockResolvedValue({ size: 500, httpEtag: ETAG });
    ENV.mockGet.mockResolvedValue(fakeR2Object({ size: 500 }));
    const res = await GET(buildRequest(VALID_KEY, { range: 'bytes=200-100' }), params(VALID_KEY));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
    expect(ENV.mockGet).toHaveBeenCalledWith(`site-media/${VALID_KEY}`);
  });

  it('503 when the R2 get() call throws', async () => {
    ENV.mockGet.mockRejectedValueOnce(new Error('r2 timeout'));
    const res = await GET(buildRequest(VALID_KEY), params(VALID_KEY));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage_unavailable' });
  });

  it('503 when the R2 head() call throws for a ranged request', async () => {
    ENV.mockHead.mockRejectedValueOnce(new Error('r2 timeout'));
    const res = await GET(buildRequest(VALID_KEY, { range: 'bytes=0-99' }), params(VALID_KEY));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage_unavailable' });
  });
});

describe('HEAD /api/media/[key]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ENV.PRINT_ASSETS = { get: ENV.mockGet, head: ENV.mockHead };
    ENV.mockGet.mockReset();
    ENV.mockHead.mockReset();
  });

  it('404 with JSON error on an invalid key', async () => {
    const res = await HEAD(buildRequest(INVALID_KEY, { method: 'HEAD' }), params(INVALID_KEY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(ENV.mockHead).not.toHaveBeenCalled();
  });

  it('404 when the R2 object is missing', async () => {
    ENV.mockHead.mockResolvedValue(null);
    const res = await HEAD(buildRequest(VALID_KEY, { method: 'HEAD' }), params(VALID_KEY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('returns headers without a body', async () => {
    ENV.mockHead.mockResolvedValue(fakeR2Object({ size: 8192 }));
    const res = await HEAD(buildRequest(VALID_KEY, { method: 'HEAD' }), params(VALID_KEY));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('content-length')).toBe('8192');
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('503 when the R2 head() call throws', async () => {
    ENV.mockHead.mockRejectedValueOnce(new Error('r2 timeout'));
    const res = await HEAD(buildRequest(VALID_KEY, { method: 'HEAD' }), params(VALID_KEY));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage_unavailable' });
  });
});
