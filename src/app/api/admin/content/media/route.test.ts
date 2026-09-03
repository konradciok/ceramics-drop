// Route-level tests for the admin site-media upload route, modeled on
// src/app/api/media/[key]/route.test.ts's getCloudflareContext mock pattern.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HERO_DESKTOP_MAX_BYTES, HERO_MOBILE_MAX_BYTES, MAX_VIDEO_BYTES } from '@/lib/admin/site-media-upload';

const ENV = vi.hoisted(() => {
  const mockPut = vi.fn();
  return { PRINT_ASSETS: { put: mockPut } as { put: typeof mockPut } | undefined, mockPut };
});

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: ENV }),
}));

import { POST } from './route';

/** A minimal valid WEBP payload of the given total byte size (magic-byte
    header + zero-padding). */
function makeWebpBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0);
  return bytes;
}

function buildRequest(opts: {
  bytes?: Uint8Array;
  width?: number;
  height?: number;
  slot?: string | null;
  contentType?: string;
  declaredLength?: number;
}): Request {
  const { bytes = makeWebpBytes(100), width = 100, height = 100, slot, contentType = 'image/webp' } = opts;
  const params = new URLSearchParams({ width: String(width), height: String(height) });
  if (slot !== undefined && slot !== null) params.set('slot', slot);
  const headers: Record<string, string> = { 'content-type': contentType };
  if (opts.declaredLength !== undefined) headers['content-length'] = String(opts.declaredLength);
  return new Request(`http://localhost/api/admin/content/media?${params.toString()}`, {
    method: 'POST',
    headers,
    // Cast only: the worker tsconfig's lib pins Uint8Array's buffer generic
    // to ArrayBufferLike, which BlobPart's stricter ArrayBuffer-backed view
    // type rejects at the type level — not a real runtime mismatch (mirrors
    // the same TS DOM-lib quirk documented in site-media-upload.ts).
    body: new Blob([bytes as unknown as BlobPart]),
  });
}

describe('POST /api/admin/content/media', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ENV.PRINT_ASSETS = { put: ENV.mockPut };
    ENV.mockPut.mockReset();
    ENV.mockPut.mockResolvedValue(undefined);
  });

  it('413s on an oversized declared content-length before ever reaching storage', async () => {
    // The declared header can lie (route.ts's own comment) — a small real
    // body with a spoofed, over-ceiling content-length header must still
    // short-circuit on the header check, never getting as far as R2 `put`.
    const req = buildRequest({ bytes: makeWebpBytes(100), declaredLength: MAX_VIDEO_BYTES + 1 });

    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(ENV.mockPut).not.toHaveBeenCalled();
  });

  it('400s on an unknown slot value', async () => {
    const res = await POST(buildRequest({ slot: 'tablet' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_slot' });
    expect(ENV.mockPut).not.toHaveBeenCalled();
  });

  it('no slot param -> no budget enforced beyond the hard ceiling (non-hero caller)', async () => {
    const res = await POST(buildRequest({ bytes: makeWebpBytes(HERO_DESKTOP_MAX_BYTES + 1) }));
    expect(res.status).toBe(200);
  });

  it('rejects a desktop-slot upload over the desktop hero budget with over_budget/413', async () => {
    const res = await POST(
      buildRequest({ slot: 'desktop', bytes: makeWebpBytes(HERO_DESKTOP_MAX_BYTES + 1) }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'over_budget' });
    expect(ENV.mockPut).not.toHaveBeenCalled();
  });

  it('accepts a desktop-slot upload at the desktop hero budget', async () => {
    const res = await POST(buildRequest({ slot: 'desktop', bytes: makeWebpBytes(HERO_DESKTOP_MAX_BYTES) }));
    expect(res.status).toBe(200);
  });

  it('rejects a mobile-slot upload between the mobile and desktop budgets with over_budget/413', async () => {
    const res = await POST(
      buildRequest({ slot: 'mobile', bytes: makeWebpBytes(HERO_MOBILE_MAX_BYTES + 1) }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'over_budget' });
  });

  it('503s when the R2 put() call throws', async () => {
    ENV.mockPut.mockRejectedValueOnce(new Error('r2 timeout'));
    const res = await POST(buildRequest({}));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage_unavailable' });
  });

  it('happy path: 200 with { key, contentType, width, height, url }', async () => {
    const res = await POST(buildRequest({ width: 640, height: 480 }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { key: string; contentType: string; width: number; height: number; url: string };
    expect(data.contentType).toBe('image/webp');
    expect(data.width).toBe(640);
    expect(data.height).toBe(480);
    expect(data.key).toMatch(/^[0-9a-f]{64}\.webp$/);
    expect(data.url).toContain(data.key);
    expect(ENV.mockPut).toHaveBeenCalledWith(
      `site-media/${data.key}`,
      expect.anything(),
      expect.objectContaining({ httpMetadata: { contentType: 'image/webp' } }),
    );
  });
});
