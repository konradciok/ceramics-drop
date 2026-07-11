// Characterization tests for the print-assets GET route (Phase 0 safety baseline).
//
// These tests pin the route's CURRENT behaviour. The plan's Phase 0 bullet also
// names "revoked asset", "HEAD metadata", and distinct 410/503 statuses — none of
// those exist in the route yet; they are introduced in Phase 4. Coverage for a
// revoked-status path, a HEAD handler, and metadata-only responses is therefore
// DEFERRED to Phase 4. Do not add them here.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENV = vi.hoisted(() => {
  const mockGet = vi.fn();
  return {
    PRINT_ASSET_TOKEN_SECRET: 'secret_test' as string | undefined,
    PRINT_ASSETS: { get: mockGet } as { get: typeof mockGet } | undefined,
    mockGet,
  };
});

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: ENV }),
}));

import { GET } from './route';
import { signPrintAssetUrl, printAssetKey } from '@/lib/print-assets';

const ID = 'fap01';
const SECRET = 'secret_test';

/** Mint a valid exp/sig pair for `id`. Defaults to real now (verify uses Date.now());
 * pass a past `nowMs` only for the expired-signature case. */
async function mintSig(id: string, secret: string, nowMs = Date.now()) {
  const url = new URL(await signPrintAssetUrl(id, secret, nowMs));
  return { exp: url.searchParams.get('exp')!, sig: url.searchParams.get('sig')! };
}

function buildRequest(id: string, qs?: { exp: string; sig: string }) {
  const search = qs ? `?exp=${qs.exp}&sig=${qs.sig}` : '';
  return new Request(`http://localhost/api/print-assets/${id}${search}`);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Fake R2 object body. Defaults form a ReadableStream of "print-master-payload". */
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
  });

  it('503 when PRINT_ASSET_TOKEN_SECRET is unset', async () => {
    ENV.PRINT_ASSET_TOKEN_SECRET = undefined;
    const { exp, sig } = await mintSig(ID, SECRET);
    const res = await GET(buildRequest(ID, { exp, sig }), params(ID));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('503 when the PRINT_ASSETS R2 binding is absent', async () => {
    ENV.PRINT_ASSETS = undefined;
    const { exp, sig } = await mintSig(ID, SECRET);
    const res = await GET(buildRequest(ID, { exp, sig }), params(ID));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('403 when the sig query param is missing entirely', async () => {
    const res = await GET(buildRequest(ID), params(ID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('403 when the exp query param is missing (sig only)', async () => {
    const { sig } = await mintSig(ID, SECRET);
    const res = await GET(
      new Request(`http://localhost/api/print-assets/${ID}?sig=${sig}`),
      params(ID),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('403 when exp is not a number', async () => {
    const { sig } = await mintSig(ID, SECRET);
    const res = await GET(
      new Request(`http://localhost/api/print-assets/${ID}?exp=not-a-number&sig=${sig}`),
      params(ID),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('403 on a wrong signature', async () => {
    const { exp } = await mintSig(ID, SECRET);
    const res = await GET(buildRequest(ID, { exp, sig: 'deadbeef' }), params(ID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('403 on an expired exp (signature was once valid)', async () => {
    // Minted well in the past; verifyPrintAssetSig rejects expired links.
    const { exp, sig } = await mintSig(ID, SECRET, 1_000);
    const res = await GET(buildRequest(ID, { exp, sig }), params(ID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ENV.mockGet).not.toHaveBeenCalled();
  });

  it('404 when the signature is valid but the R2 object is missing', async () => {
    ENV.mockGet.mockResolvedValue(null);
    const { exp, sig } = await mintSig(ID, SECRET);
    const res = await GET(buildRequest(ID, { exp, sig }), params(ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(ENV.mockGet).toHaveBeenCalledWith(printAssetKey(ID));
  });

  it('streams the object body and sets the headers from httpMetadata', async () => {
    ENV.mockGet.mockResolvedValue(fakeR2Object({ contentType: 'image/png', size: 4096 }));
    const { exp, sig } = await mintSig(ID, SECRET);
    const res = await GET(buildRequest(ID, { exp, sig }), params(ID));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('print-master-payload');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe('4096');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('falls back to image/jpeg content-type when httpMetadata is absent', async () => {
    ENV.mockGet.mockResolvedValue(fakeR2Object());
    const { exp, sig } = await mintSig(ID, SECRET);
    const res = await GET(buildRequest(ID, { exp, sig }), params(ID));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('requests the object under the current key scheme ({id}/master.jpg)', async () => {
    ENV.mockGet.mockResolvedValue(fakeR2Object());
    const { exp, sig } = await mintSig(ID, SECRET);
    await GET(buildRequest(ID, { exp, sig }), params(ID));
    expect(ENV.mockGet).toHaveBeenCalledTimes(1);
    expect(ENV.mockGet).toHaveBeenCalledWith(printAssetKey(ID));
    expect(printAssetKey(ID)).toBe(`${ID}/master.jpg`);
  });
});
