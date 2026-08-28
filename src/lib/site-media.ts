/**
 * Pure helpers for the CMS-managed site-media assets (homepage hero images/video)
 * served publicly and uncached-by-auth from R2 via GET/HEAD /api/media/[key].
 *
 * Keys are content-addressed: a 64-char lowercase hex digest + extension, e.g.
 * `<sha256>.webp`. No path segments, no uppercase, no traversal — the regexes
 * below double as the input-validation gate for the serving route.
 */

/** R2 key prefix all site-media objects live under. */
export const SITE_MEDIA_PREFIX = 'site-media/';

/** Matches a bare site-media image key: 64-hex + webp/jpg/jpeg/png. */
export const IMAGE_KEY_RE = /^[a-f0-9]{64}\.(webp|jpe?g|png)$/;

/** Matches a bare site-media video key: 64-hex + mp4/webm. */
export const VIDEO_KEY_RE = /^[a-f0-9]{64}\.(mp4|webm)$/;

/** Matches any valid site-media key — image or video. */
export const SITE_MEDIA_KEY_RE = /^[a-f0-9]{64}\.(webp|jpe?g|png|mp4|webm)$/;

/** Extension → content-type, server-controlled (never taken from the client). */
export const EXT_CONTENT_TYPES: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** Builds the public, relative serving URL for a site-media key. */
export function siteMediaUrl(key: string): string {
  return `/api/media/${key}`;
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a `Range` request header for a single byte range against a known
 * object size, per RFC 9110 §14.1.2 (single-range only — no multipart).
 *
 * - Absent, empty, or syntactically malformed (unsupported form, multiple
 *   ranges, first-byte-pos > last-byte-pos) → `null`, meaning "ignore the
 *   Range header and serve the whole file with 200" (RFC 9110 allows a
 *   server to ignore an invalid Range header rather than reject it).
 * - Syntactically valid but unsatisfiable against `size` (start at or past
 *   the end of the file, or a zero-length suffix) → the literal string
 *   `'invalid'`, meaning "respond 416".
 * - Otherwise → absolute, inclusive `{ start, end }` offsets, clamped to
 *   `size - 1`. A suffix range longer than the file clamps to the whole file.
 */
export function parseRangeHeader(
  header: string | null | undefined,
  size: number,
): ByteRange | 'invalid' | null {
  if (!header) return null;
  if (size <= 0) return 'invalid';

  const bounded = /^bytes=(\d+)-(\d+)$/.exec(header);
  if (bounded) {
    const start = Number(bounded[1]);
    const end = Number(bounded[2]);
    if (start > end) return null; // malformed: first-byte-pos > last-byte-pos
    if (start >= size) return 'invalid';
    return { start, end: Math.min(end, size - 1) };
  }

  const openEnded = /^bytes=(\d+)-$/.exec(header);
  if (openEnded) {
    const start = Number(openEnded[1]);
    if (start >= size) return 'invalid';
    return { start, end: size - 1 };
  }

  const suffix = /^bytes=-(\d+)$/.exec(header);
  if (suffix) {
    const n = Number(suffix[1]);
    if (n === 0) return 'invalid';
    const start = n >= size ? 0 : size - n;
    return { start, end: size - 1 };
  }

  return null;
}

/**
 * Builds the response header set for a site-media GET/HEAD, deriving
 * content-type from the key's extension (never from client input or R2
 * metadata) and, when `range` is given, the 206 partial-content headers.
 */
export function siteMediaHeaders(
  obj: { size: number; httpEtag: string },
  key: string,
  range?: ByteRange | null,
): Headers {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  const contentType = EXT_CONTENT_TYPES[ext] ?? 'application/octet-stream';

  const headers = new Headers({
    'content-type': contentType,
    etag: obj.httpEtag,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });

  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${obj.size}`);
    headers.set('content-length', String(range.end - range.start + 1));
  } else {
    headers.set('content-length', String(obj.size));
  }

  return headers;
}
