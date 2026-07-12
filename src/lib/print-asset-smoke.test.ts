import { describe, it, expect, vi } from 'vitest';
import {
  redactSignedPrintAssetUrl,
  probeSignedPrintAssetHead,
  type HeadProbeResult,
} from './print-asset-smoke';

describe('redactSignedPrintAssetUrl', () => {
  it('replaces sig query param with a redacted placeholder', () => {
    const url =
      'https://anna-ciok.studio/api/print-assets/abc?exp=1700000000&sig=deadbeef'.repeat(4);
    const redacted = redactSignedPrintAssetUrl(url);
    expect(redacted).not.toContain('deadbeef');
    expect(new URL(redacted).searchParams.get('sig')).toBe('[REDACTED]');
    expect(redacted).toContain('exp=1700000000');
    expect(redacted).toContain('/api/print-assets/abc');
  });
});

describe('probeSignedPrintAssetHead', () => {
  it('returns metadata on HTTP 200 without logging the signature', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '12345',
          etag: '"abc123"',
        },
      }),
    );

    const signedUrl =
      'https://example.test/api/print-assets/asset-1?exp=999&sig=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    const result: HeadProbeResult = await probeSignedPrintAssetHead(signedUrl, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(signedUrl, { method: 'HEAD' });
    expect(result).toEqual({
      ok: true,
      status: 200,
      url: redactSignedPrintAssetUrl(signedUrl),
      contentType: 'image/jpeg',
      contentLength: 12345,
      etag: '"abc123"',
    });
  });

  it('surfaces non-200 responses with redacted URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    const signedUrl = 'https://example.test/api/print-assets/x?exp=1&sig=' + 'a'.repeat(64);

    const result = await probeSignedPrintAssetHead(signedUrl, fetchFn);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.url).toBe(redactSignedPrintAssetUrl(signedUrl));
    expect(result.url).not.toContain('a'.repeat(64));
  });

  it('rejects a non-200 2xx response (e.g. 206 Partial Content)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 206,
        headers: { 'content-type': 'image/jpeg', 'content-length': '12345' },
      }),
    );
    const signedUrl = 'https://example.test/api/print-assets/z?exp=1&sig=' + 'c'.repeat(64);

    const result = await probeSignedPrintAssetHead(signedUrl, fetchFn);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(206);
  });

  it('redacts the signed URL out of a network-error message', async () => {
    const signedUrl = 'https://example.test/api/print-assets/w?exp=1&sig=' + 'd'.repeat(64);
    const fetchFn = vi.fn().mockRejectedValue(new Error(`Failed to parse URL from ${signedUrl}`));

    const result = await probeSignedPrintAssetHead(signedUrl, fetchFn);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('d'.repeat(64));
      expect(result.error).toContain(redactSignedPrintAssetUrl(signedUrl));
    }
  });

  it('fails closed on a 200 HEAD missing content-length', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
    );
    const signedUrl = 'https://example.test/api/print-assets/y?exp=1&sig=' + 'b'.repeat(64);

    const result = await probeSignedPrintAssetHead(signedUrl, fetchFn);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    if (!result.ok) {
      expect(result.error).toBe('missing content-type or content-length on 200 HEAD');
    }
  });
});
