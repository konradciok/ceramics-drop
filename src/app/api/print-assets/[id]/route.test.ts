// Characterization tests for the print-assets GET route.
// Phase 3 resolves snapshotted assetId → immutable r2_key (Phase 4 adds HEAD/revoked).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENV = vi.hoisted(() => {
  const mockGet = vi.fn();
  return {
    PRINT_ASSET_TOKEN_SECRET: 'secret_test' as string | undefined,
    PRINT_ASSETS: { get: mockGet } as { get: typeof mockGet } | undefined,
    mockGet,
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

import { GET } from './route';
import { signPrintAssetUrl } from '@/lib/print-assets';

const ASSET_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const R2_KEY = 'prints/fap01/rev1/4800x7200-abc.jpg';
const SECRET = 'secret_test';

async function mintSig(id: string, secret: string, nowMs = Date.now()) {
  const url = new URL(await signPrintAssetUrl(id, secret, nowMs));
  return { exp: url.searchParams.get('exp')!, sig: url.searchParams.get('sig')! };
}

function buildRequest(id: string, qs?: { exp: string; sig: string }) {
  const search = qs ? `?exp=${qs.exp}&sig=${qs.sig}` : '';
  return new Request(`http://localhost/api/print-assets/${id}${search}`);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function fakeR2Object(opts: { contentType?: string; size?: number; body?: string } = {}) {
  const { contentType, size = 1234, body = 'print-master-payload' } = opts;
  return {
    body: new Response(body).body,
    size,
    httpMetadata: contentType ? { contentType } : undefined,
  };
}

describe('GET /api/print-assets/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ENV.PRINT_ASSET_TOKEN_SECRET = SECRET;
    ENV.PRINT_ASSETS = { get: ENV.mockGet };
    ENV.mockGet.mockReset();
    mockResolveAssetR2Key.mockResolvedValue({
      r2Key: R2_KEY,
      contentType: 'image/jpeg',
      status: 'ready',
    });
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

  it('403 on a wrong signature', async () => {
    const { exp } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig: 'deadbeef' }), params(ASSET_ID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('404 when the asset record is unknown or revoked', async () => {
    mockResolveAssetR2Key.mockResolvedValueOnce(null);
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
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

  it('streams the object body and sets the headers from httpMetadata', async () => {
    ENV.mockGet.mockResolvedValue(fakeR2Object({ contentType: 'image/png', size: 4096 }));
    const { exp, sig } = await mintSig(ASSET_ID, SECRET);
    const res = await GET(buildRequest(ASSET_ID, { exp, sig }), params(ASSET_ID));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('print-master-payload');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe('4096');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('falls back to the asset record content-type when httpMetadata is absent', async () => {
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
