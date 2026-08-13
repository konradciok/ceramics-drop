// Characterization tests for the print-assets GET/HEAD routes.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENV = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockHead = vi.fn();
  return {
    PRINT_ASSET_TOKEN_SECRET: 'secret_test' as string | undefined,
    PRINT_ASSETS: { get: mockGet, head: mockHead } as {
      get: typeof mockGet;
      head: typeof mockHead;
    } | undefined,
    mockGet,
    mockHead,
  };
});

const { mockResolveAssetR2Key } = vi.hoisted(() => ({
  mockResolveAssetR2Key: vi.fn(),
}));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: ENV }),
}));
vi.mock('@/server/print-assets/repository', () => ({
  resolveAssetR2Key: mockResolveAssetR2Key,
}));

import { GET, HEAD } from './route';
import { signPrintAssetUrl } from '@/lib/print-assets';

const ASSET_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const R2_KEY = 'prints/fap01/rev1/4800x7200-abc.jpg';
const SECRET = 'secret_test';
const ETAG = '"abc123"';

const FOUND_ASSET = {
  kind: 'found' as const,
  r2Key: R2_KEY,
  contentType: 'image/jpeg' as const,
  status: 'ready',
};

async function mintSig(id: string, secret: string, nowMs = Date.now()) {
  const url = new URL(await signPrintAssetUrl(id, secret, nowMs));
  return { exp: url.searchParams.get('exp')!, sig: url.searchParams.get('sig')! };
}

function buildRequest(id: string, qs?: { exp: string; sig: string }, method = 'GET') {
  const search = qs ? `?exp=${qs.exp}&sig=${qs.sig}` : '';
  return new Request(`http://localhost/api/print-assets/${id}${search}`, { method });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function fakeR2Object(opts: { contentType?: string; size?: number; body?: string; httpEtag?: string } = {}) {
  const { contentType, size = 1234, body = 'print-master-payload', httpEtag = ETAG } = opts;
  return {
    body: new Response(body).body,
    size,
    httpEtag,
    httpMetadata: contentType ? { contentType } : undefined,
  };
}

describe('GET /api/print-assets/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ENV.PRINT_ASSET_TOKEN_SECRET = SECRET;
    ENV.PRINT_ASSETS = { get: ENV.mockGet, head: ENV.mockHead };
    ENV.mockGet.mockReset();
    ENV.mockHead.mockReset();
    mockResolveAssetR2Key.mockResolvedValue(FOUND_ASSET);
  });

  it('503 when PRINT_ASSET_TOKEN_SECRET is unset', async () => {
    ENV.PRINT_ASSET_TOKEN_SECRET = undefined;
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('503 when the PRINT_ASSETS R2 binding is absent', async () => {
    ENV.PRINT_ASSETS = undefined;
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('403 when the sig query param is missing entirely', async () => {
    const res = await GET(buildRequest(ASSET_ID), params(ASSET_ID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('403 when the exp query param is missing (sig only)', async () => {
    const { sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(
      new Request(`http://localhost/api/print-assets/${ASSET_ID}?sig=${sig}`),
      params(ASSET_ID),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
    expect(mockResolveAssetR2Key).not.toHaveBeenCalled();
  });

  it('403 when exp is not a number', async () => {
    const { sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(
      new Request(`http://localhost/api/print-assets/${ASSET_ID}?exp=not-a-number&sig=${sig}`),
      params(ASSET_ID),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
    expect(mockResolveAssetR2Key).not.toHaveBeenCalled();
  });

  it('403 on an expired exp (signature was once valid)', async () => {
    const { exp, sig } = await mintSig(ASSET_ID, SECRET, 1_000);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
    expect(mockResolveAssetR2Key).not.toHaveBeenCalled();
  });

  it('403 on a wrong signature', async () => {
    const { exp } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig: 'deadbeef' }), params(ASSET_ID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('503 when the asset DB lookup throws', async () => {
    mockResolveAssetR2Key.mockRejectedValueOnce(new Error('connection reset'));
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('404 when the asset record is unknown', async () => {
    mockResolveAssetR2Key.mockResolvedValueOnce({ kind: 'not_found' });
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('410 when the asset is revoked', async () => {
    mockResolveAssetR2Key.mockResolvedValueOnce({ kind: 'revoked' });
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'gone' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('404 when the signature is valid but the R2 object is missing', async () => {
    ENV.mockGet.mockResolvedValue(null);
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(mockResolveAssetR2Key).toHaveBeenCalledWith(ASSET_ID);
    expect(ENV.mockGet).toHaveBeenCalledWith(R2_KEY);
  });

  it('503 when the R2 get() call throws (transient infra failure)', async () => {
    ENV.mockGet.mockRejectedValueOnce(new Error('r2 timeout'));
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('streams the object body; the DB-validated content-type wins over httpMetadata (L-24)', async () => {
    ENV.mockGet.mockResolvedValue(fakeR2Object({ contentType: 'image/png', size: 4096 }));
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('print-master-payload');
    // DB record says image/jpeg; R2 httpMetadata (unvalidated) says image/png.
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-length')).toBe('4096');
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('falls back to R2 httpMetadata only when the DB column is null (L-24)', async () => {
    mockResolveAssetR2Key.mockResolvedValueOnce({ ...FOUND_ASSET, contentType: null });
    ENV.mockGet.mockResolvedValue(fakeR2Object({ contentType: 'image/png' }));
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('serves the DB content-type when httpMetadata is absent', async () => {
    ENV.mockGet.mockResolvedValue(fakeR2Object());
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('resolves assetId to the immutable r2_key before streaming', async () => {
    ENV.mockGet.mockResolvedValue(fakeR2Object());
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(mockResolveAssetR2Key).toHaveBeenCalledWith(ASSET_ID);
    expect(ENV.mockGet).toHaveBeenCalledWith(R2_KEY);
  });
});

describe('HEAD /api/print-assets/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ENV.PRINT_ASSET_TOKEN_SECRET = SECRET;
    ENV.PRINT_ASSETS = { get: ENV.mockGet, head: ENV.mockHead };
    ENV.mockGet.mockReset();
    ENV.mockHead.mockReset();
    mockResolveAssetR2Key.mockResolvedValue(FOUND_ASSET);
  });

  it('403 when the signature is invalid', async () => {
    const res = await HEAD(buildRequest(ASSET_ID), params(ASSET_ID));
    expect(res.status).toBe(403);
    expect(ENV.mockHead).not.toHaveBeenCalled();
  });

  it('503 when the asset DB lookup throws', async () => {
    mockResolveAssetR2Key.mockRejectedValueOnce(new Error('connection reset'));
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await HEAD(buildRequest(ASSET_ID, { exp, sig }, 'HEAD'), params(ASSET_ID));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(ENV.mockHead).not.toHaveBeenCalled();
  });

  it('410 when the asset is revoked', async () => {
    mockResolveAssetR2Key.mockResolvedValueOnce({ kind: 'revoked' });
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await HEAD(buildRequest(ASSET_ID, { exp, sig }, 'HEAD'), params(ASSET_ID));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'gone' });
    expect(ENV.mockHead).not.toHaveBeenCalled();
  });

  it('404 when the R2 object is missing', async () => {
    ENV.mockHead.mockResolvedValue(null);
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await HEAD(buildRequest(ASSET_ID, { exp, sig }, 'HEAD'), params(ASSET_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(ENV.mockHead).toHaveBeenCalledWith(R2_KEY);
  });

  it('503 when the R2 head() call throws (transient infra failure)', async () => {
    ENV.mockHead.mockRejectedValueOnce(new Error('r2 timeout'));
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await HEAD(buildRequest(ASSET_ID, { exp, sig }, 'HEAD'), params(ASSET_ID));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('returns metadata headers with no body', async () => {
    ENV.mockHead.mockResolvedValue(fakeR2Object({ contentType: 'image/jpeg', size: 8192 }));
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await HEAD(buildRequest(ASSET_ID, { exp, sig }, 'HEAD'), params(ASSET_ID));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-length')).toBe('8192');
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
