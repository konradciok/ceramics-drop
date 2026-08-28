import { describe, it, expect } from 'vitest';
import {
  SITE_MEDIA_PREFIX,
  SITE_MEDIA_KEY_RE,
  IMAGE_KEY_RE,
  VIDEO_KEY_RE,
  EXT_CONTENT_TYPES,
  siteMediaUrl,
  parseRangeHeader,
  siteMediaHeaders,
} from './site-media';

const HEX64 = 'a'.repeat(64);

describe('SITE_MEDIA_PREFIX', () => {
  it('is the fixed R2 key prefix', () => {
    expect(SITE_MEDIA_PREFIX).toBe('site-media/');
  });
});

describe('IMAGE_KEY_RE', () => {
  it('matches 64-hex keys with webp/jpg/jpeg/png extensions', () => {
    expect(IMAGE_KEY_RE.test(`${HEX64}.webp`)).toBe(true);
    expect(IMAGE_KEY_RE.test(`${HEX64}.jpg`)).toBe(true);
    expect(IMAGE_KEY_RE.test(`${HEX64}.jpeg`)).toBe(true);
    expect(IMAGE_KEY_RE.test(`${HEX64}.png`)).toBe(true);
  });

  it('rejects video extensions', () => {
    expect(IMAGE_KEY_RE.test(`${HEX64}.mp4`)).toBe(false);
    expect(IMAGE_KEY_RE.test(`${HEX64}.webm`)).toBe(false);
  });

  it('rejects wrong-length hex', () => {
    expect(IMAGE_KEY_RE.test(`${'a'.repeat(63)}.webp`)).toBe(false);
    expect(IMAGE_KEY_RE.test(`${'a'.repeat(65)}.webp`)).toBe(false);
  });

  it('rejects uppercase hex', () => {
    expect(IMAGE_KEY_RE.test(`${'A'.repeat(64)}.webp`)).toBe(false);
  });

  it('rejects path traversal / extra path segments', () => {
    expect(IMAGE_KEY_RE.test(`../${HEX64}.webp`)).toBe(false);
    expect(IMAGE_KEY_RE.test(`foo/${HEX64}.webp`)).toBe(false);
    expect(IMAGE_KEY_RE.test(`${HEX64}.webp/../etc`)).toBe(false);
  });

  it('rejects unknown extensions', () => {
    expect(IMAGE_KEY_RE.test(`${HEX64}.gif`)).toBe(false);
    expect(IMAGE_KEY_RE.test(`${HEX64}.svg`)).toBe(false);
  });
});

describe('VIDEO_KEY_RE', () => {
  it('matches 64-hex keys with mp4/webm extensions', () => {
    expect(VIDEO_KEY_RE.test(`${HEX64}.mp4`)).toBe(true);
    expect(VIDEO_KEY_RE.test(`${HEX64}.webm`)).toBe(true);
  });

  it('rejects image extensions', () => {
    expect(VIDEO_KEY_RE.test(`${HEX64}.webp`)).toBe(false);
    expect(VIDEO_KEY_RE.test(`${HEX64}.png`)).toBe(false);
  });

  it('rejects wrong-length hex and uppercase', () => {
    expect(VIDEO_KEY_RE.test(`${'a'.repeat(63)}.mp4`)).toBe(false);
    expect(VIDEO_KEY_RE.test(`${'A'.repeat(64)}.mp4`)).toBe(false);
  });
});

describe('SITE_MEDIA_KEY_RE', () => {
  it('accepts anything IMAGE_KEY_RE or VIDEO_KEY_RE accepts', () => {
    expect(SITE_MEDIA_KEY_RE.test(`${HEX64}.webp`)).toBe(true);
    expect(SITE_MEDIA_KEY_RE.test(`${HEX64}.jpg`)).toBe(true);
    expect(SITE_MEDIA_KEY_RE.test(`${HEX64}.jpeg`)).toBe(true);
    expect(SITE_MEDIA_KEY_RE.test(`${HEX64}.png`)).toBe(true);
    expect(SITE_MEDIA_KEY_RE.test(`${HEX64}.mp4`)).toBe(true);
    expect(SITE_MEDIA_KEY_RE.test(`${HEX64}.webm`)).toBe(true);
  });

  it('rejects unknown extensions, wrong length, uppercase, path traversal', () => {
    expect(SITE_MEDIA_KEY_RE.test(`${HEX64}.gif`)).toBe(false);
    expect(SITE_MEDIA_KEY_RE.test(`${'a'.repeat(63)}.webp`)).toBe(false);
    expect(SITE_MEDIA_KEY_RE.test(`${'A'.repeat(64)}.webp`)).toBe(false);
    expect(SITE_MEDIA_KEY_RE.test(`../${HEX64}.webp`)).toBe(false);
    expect(SITE_MEDIA_KEY_RE.test(`${SITE_MEDIA_PREFIX}${HEX64}.webp`)).toBe(false);
  });
});

describe('EXT_CONTENT_TYPES', () => {
  it('maps every supported extension to its content type', () => {
    expect(EXT_CONTENT_TYPES.webp).toBe('image/webp');
    expect(EXT_CONTENT_TYPES.jpg).toBe('image/jpeg');
    expect(EXT_CONTENT_TYPES.jpeg).toBe('image/jpeg');
    expect(EXT_CONTENT_TYPES.png).toBe('image/png');
    expect(EXT_CONTENT_TYPES.mp4).toBe('video/mp4');
    expect(EXT_CONTENT_TYPES.webm).toBe('video/webm');
  });

  it('has no entry for unsupported extensions', () => {
    expect(EXT_CONTENT_TYPES.gif).toBeUndefined();
  });
});

describe('siteMediaUrl', () => {
  it('builds a relative /api/media/<key> path', () => {
    expect(siteMediaUrl(`${HEX64}.webp`)).toBe(`/api/media/${HEX64}.webp`);
  });

  it('is not origin-qualified', () => {
    expect(siteMediaUrl(`${HEX64}.mp4`).startsWith('/api/media/')).toBe(true);
    expect(siteMediaUrl(`${HEX64}.mp4`)).not.toContain('http');
  });
});

describe('parseRangeHeader', () => {
  const SIZE = 1000;

  it('returns null for an absent header', () => {
    expect(parseRangeHeader(null, SIZE)).toBeNull();
    expect(parseRangeHeader(undefined, SIZE)).toBeNull();
    expect(parseRangeHeader('', SIZE)).toBeNull();
  });

  it('parses a bounded range bytes=100-199', () => {
    expect(parseRangeHeader('bytes=100-199', SIZE)).toEqual({ start: 100, end: 199 });
  });

  it('parses an open-ended range bytes=0-', () => {
    expect(parseRangeHeader('bytes=0-', SIZE)).toEqual({ start: 0, end: SIZE - 1 });
  });

  it('parses a mid-file open-ended range', () => {
    expect(parseRangeHeader('bytes=500-', SIZE)).toEqual({ start: 500, end: SIZE - 1 });
  });

  it('parses a suffix range bytes=-500', () => {
    expect(parseRangeHeader('bytes=-500', SIZE)).toEqual({ start: 500, end: SIZE - 1 });
  });

  it('clamps a bounded range whose end exceeds size', () => {
    expect(parseRangeHeader('bytes=0-999999', SIZE)).toEqual({ start: 0, end: SIZE - 1 });
  });

  it('clamps a suffix range larger than the file to the whole file', () => {
    expect(parseRangeHeader('bytes=-5000', SIZE)).toEqual({ start: 0, end: SIZE - 1 });
  });

  it('returns null for a malformed header (no "bytes=" prefix)', () => {
    expect(parseRangeHeader('items=0-10', SIZE)).toBeNull();
  });

  it('returns null for a malformed header (garbage)', () => {
    expect(parseRangeHeader('bytes=abc-def', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=', SIZE)).toBeNull();
  });

  it('returns null for a multi-range header (unsupported)', () => {
    expect(parseRangeHeader('bytes=0-10,20-30', SIZE)).toBeNull();
  });

  it('returns null when first-byte-pos exceeds last-byte-pos', () => {
    expect(parseRangeHeader('bytes=500-100', SIZE)).toBeNull();
  });

  it("returns 'invalid' when start is at or past the file size", () => {
    expect(parseRangeHeader('bytes=1000-1005', SIZE)).toBe('invalid');
    expect(parseRangeHeader(`bytes=${SIZE}-`, SIZE)).toBe('invalid');
  });

  it("returns 'invalid' for a zero-length suffix", () => {
    expect(parseRangeHeader('bytes=-0', SIZE)).toBe('invalid');
  });

  it("returns 'invalid' when size is zero", () => {
    expect(parseRangeHeader('bytes=0-10', 0)).toBe('invalid');
  });
});

describe('siteMediaHeaders', () => {
  const obj = { size: 2048, httpEtag: '"abc123"' };
  const key = `${HEX64}.webp`;

  it('builds whole-file headers when no range is given', () => {
    const headers = siteMediaHeaders(obj, key);
    expect(headers.get('content-type')).toBe('image/webp');
    expect(headers.get('etag')).toBe('"abc123"');
    expect(headers.get('accept-ranges')).toBe('bytes');
    expect(headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('content-length')).toBe('2048');
    expect(headers.get('content-range')).toBeNull();
  });

  it('derives content-type from the extension for video keys', () => {
    const headers = siteMediaHeaders(obj, `${HEX64}.mp4`);
    expect(headers.get('content-type')).toBe('video/mp4');
  });

  it('builds partial-content headers when a range is given', () => {
    const headers = siteMediaHeaders(obj, key, { start: 100, end: 199 });
    expect(headers.get('content-range')).toBe('bytes 100-199/2048');
    expect(headers.get('content-length')).toBe('100');
  });
});
