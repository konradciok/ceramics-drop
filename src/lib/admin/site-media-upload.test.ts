import { describe, it, expect } from 'vitest';
import { validateUpload, uploadKeyFor } from './site-media-upload';

// --- Fixtures: minimal valid magic-byte headers for each allowed type -----

const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0,
]);

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

const MP4_BYTES = new Uint8Array([
  0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);

const WEBM_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);

function baseInput(overrides: Partial<Parameters<typeof validateUpload>[0]> = {}) {
  return {
    contentType: 'image/webp',
    contentLength: WEBP_BYTES.byteLength,
    width: 100,
    height: 100,
    bytes: WEBP_BYTES,
    ...overrides,
  };
}

describe('validateUpload', () => {
  it('accepts a valid webp payload and returns the normalized ext', () => {
    const result = validateUpload(baseInput());
    expect(result).toEqual({ ok: true, ext: 'webp', contentType: 'image/webp' });
  });

  it('accepts a valid png payload', () => {
    const result = validateUpload(
      baseInput({ contentType: 'image/png', bytes: PNG_BYTES, contentLength: PNG_BYTES.byteLength }),
    );
    expect(result).toEqual({ ok: true, ext: 'png', contentType: 'image/png' });
  });

  it('accepts a valid jpeg payload', () => {
    const result = validateUpload(
      baseInput({
        contentType: 'image/jpeg',
        bytes: JPEG_BYTES,
        contentLength: JPEG_BYTES.byteLength,
      }),
    );
    expect(result).toEqual({ ok: true, ext: 'jpg', contentType: 'image/jpeg' });
  });

  it('accepts a valid mp4 payload', () => {
    const result = validateUpload(
      baseInput({
        contentType: 'video/mp4',
        bytes: MP4_BYTES,
        contentLength: MP4_BYTES.byteLength,
      }),
    );
    expect(result).toEqual({ ok: true, ext: 'mp4', contentType: 'video/mp4' });
  });

  it('accepts a valid webm payload', () => {
    const result = validateUpload(
      baseInput({
        contentType: 'video/webm',
        bytes: WEBM_BYTES,
        contentLength: WEBM_BYTES.byteLength,
      }),
    );
    expect(result).toEqual({ ok: true, ext: 'webm', contentType: 'video/webm' });
  });

  it('rejects a content type outside the allowlist with 415', () => {
    const result = validateUpload(baseInput({ contentType: 'image/gif' }));
    expect(result).toEqual({ ok: false, error: 'invalid_content_type', status: 415 });
  });

  it('rejects a declared type whose magic bytes do not match (jpeg bytes claiming png) with 415', () => {
    const result = validateUpload(
      baseInput({
        contentType: 'image/png',
        bytes: JPEG_BYTES,
        contentLength: JPEG_BYTES.byteLength,
      }),
    );
    expect(result).toEqual({ ok: false, error: 'content_type_mismatch', status: 415 });
  });

  it('rejects a declared mp4 whose bytes do not contain ftyp at offset 4 with 415', () => {
    const result = validateUpload(
      baseInput({
        contentType: 'video/mp4',
        bytes: WEBM_BYTES,
        contentLength: WEBM_BYTES.byteLength,
      }),
    );
    expect(result).toEqual({ ok: false, error: 'content_type_mismatch', status: 415 });
  });

  it('rejects an oversize image (> 8 MB) with 413', () => {
    const result = validateUpload(baseInput({ contentLength: 8 * 1024 * 1024 + 1 }));
    expect(result).toEqual({ ok: false, error: 'payload_too_large', status: 413 });
  });

  it('rejects an oversize video (> 50 MB) with 413', () => {
    const result = validateUpload(
      baseInput({
        contentType: 'video/mp4',
        bytes: MP4_BYTES,
        contentLength: 50 * 1024 * 1024 + 1,
      }),
    );
    expect(result).toEqual({ ok: false, error: 'payload_too_large', status: 413 });
  });

  it('accepts an image right at the 8 MB cap', () => {
    const result = validateUpload(baseInput({ contentLength: 8 * 1024 * 1024 }));
    expect(result.ok).toBe(true);
  });

  it('rejects absurd dimensions (zero) with 400', () => {
    const result = validateUpload(baseInput({ width: 0, height: 100 }));
    expect(result).toEqual({ ok: false, error: 'invalid_dimensions', status: 400 });
  });

  it('rejects absurd dimensions (over 10000) with 400', () => {
    const result = validateUpload(baseInput({ width: 100, height: 10001 }));
    expect(result).toEqual({ ok: false, error: 'invalid_dimensions', status: 400 });
  });

  it('rejects non-integer dimensions with 400', () => {
    const result = validateUpload(baseInput({ width: 100.5, height: 100 }));
    expect(result).toEqual({ ok: false, error: 'invalid_dimensions', status: 400 });
  });

  it('rejects missing dimensions (parsed as NaN, e.g. an absent query param) with 400', () => {
    const result = validateUpload(baseInput({ width: Number(undefined), height: 100 }));
    expect(result).toEqual({ ok: false, error: 'invalid_dimensions', status: 400 });
  });

  it('rejects negative dimensions with 400', () => {
    const result = validateUpload(baseInput({ width: -1, height: 100 }));
    expect(result).toEqual({ ok: false, error: 'invalid_dimensions', status: 400 });
  });

  describe('budgetBytes (SEO-006 hero budget)', () => {
    it('accepts a payload at or under the caller-supplied budget', () => {
      const result = validateUpload(baseInput({ contentLength: 1000, budgetBytes: 1000 }));
      expect(result.ok).toBe(true);
    });

    it('rejects a payload over the caller-supplied budget with a distinct over_budget/413', () => {
      const result = validateUpload(baseInput({ contentLength: 1001, budgetBytes: 1000 }));
      expect(result).toEqual({ ok: false, error: 'over_budget', status: 413 });
    });

    it('the hard 8 MB/50 MB ceilings still apply unchanged when budgetBytes is omitted', () => {
      const result = validateUpload(baseInput({ contentLength: 8 * 1024 * 1024 + 1 }));
      expect(result).toEqual({ ok: false, error: 'payload_too_large', status: 413 });
    });

    it('a generous budgetBytes never loosens the hard ceiling', () => {
      const result = validateUpload(
        baseInput({ contentLength: 8 * 1024 * 1024 + 1, budgetBytes: 50 * 1024 * 1024 }),
      );
      expect(result).toEqual({ ok: false, error: 'payload_too_large', status: 413 });
    });
  });
});

describe('uploadKeyFor', () => {
  it('matches a known sha256 vector for "hello world"', async () => {
    const bytes = new TextEncoder().encode('hello world');
    const key = await uploadKeyFor(bytes, 'webp');
    expect(key).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9.webp',
    );
  });

  it('is idempotent: the same bytes produce the same key', async () => {
    const bytes = new TextEncoder().encode('same content twice');
    const keyA = await uploadKeyFor(bytes, 'png');
    const keyB = await uploadKeyFor(bytes, 'png');
    expect(keyA).toBe(keyB);
  });

  it('produces different keys for different bytes', async () => {
    const keyA = await uploadKeyFor(new TextEncoder().encode('content A'), 'png');
    const keyB = await uploadKeyFor(new TextEncoder().encode('content B'), 'png');
    expect(keyA).not.toBe(keyB);
  });

  it('appends the given extension verbatim', async () => {
    const key = await uploadKeyFor(new TextEncoder().encode('x'), 'mp4');
    expect(key.endsWith('.mp4')).toBe(true);
  });
});
