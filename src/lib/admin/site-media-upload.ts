/**
 * Pure, testable validation + key-derivation helpers for the admin
 * site-media upload route (`POST /api/admin/content/media`). Kept free of
 * Cloudflare/R2 concerns so it is exhaustively unit-testable under Node.
 */

/** Raw bytes as read from the request body — either shape is accepted. */
export type UploadBytes = ArrayBuffer | Uint8Array;

export type ValidateUploadInput = {
  contentType: string;
  contentLength: number;
  width: number;
  height: number;
  bytes: UploadBytes;
};

export type ValidateUploadOk = {
  ok: true;
  /** Normalized, server-controlled extension for the R2 key — never taken
      from client input beyond the declared content-type. */
  ext: string;
  contentType: string;
};

export type ValidateUploadError = {
  ok: false;
  error: 'invalid_content_type' | 'content_type_mismatch' | 'payload_too_large' | 'invalid_dimensions';
  status: 415 | 413 | 400;
};

export type ValidateUploadResult = ValidateUploadOk | ValidateUploadError;

/** Allowed content types → normalized extension. Mirrors (but is kept
    independent of) `EXT_CONTENT_TYPES` in `src/lib/site-media.ts`, which maps
    the other direction (extension → content-type) for the serving route. */
const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

const IMAGE_CONTENT_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png']);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_DIMENSION = 10000;

function toUint8Array(bytes: UploadBytes): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** Sniffs the first bytes of the body and checks them against the magic-byte
    signature expected for the declared content-type. */
function sniffMatchesDeclaredType(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType) {
    case 'image/webp':
      // 'RIFF'....'WEBP'
      return (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    case 'image/png':
      return (
        bytes.length >= 4 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
      );
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'video/mp4':
      // ASCII 'ftyp' at byte offset 4
      return (
        bytes.length >= 8 &&
        bytes[4] === 0x66 &&
        bytes[5] === 0x74 &&
        bytes[6] === 0x79 &&
        bytes[7] === 0x70
      );
    case 'video/webm':
      // EBML header
      return (
        bytes.length >= 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3
      );
    default:
      return false;
  }
}

function isValidDimension(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_DIMENSION;
}

/**
 * Validates an admin site-media upload: content-type allowlist, magic-byte
 * sniff against the declared type, size cap (8 MB images / 50 MB videos),
 * and integer 1–10000 dimensions. Returns a discriminated result — `ok` with
 * the normalized extension, or an error code with the HTTP status the route
 * should respond with.
 */
export function validateUpload(input: ValidateUploadInput): ValidateUploadResult {
  const { contentType, contentLength, width, height, bytes } = input;

  const ext = CONTENT_TYPE_EXT[contentType];
  if (!ext) {
    return { ok: false, error: 'invalid_content_type', status: 415 };
  }

  const view = toUint8Array(bytes);
  if (!sniffMatchesDeclaredType(contentType, view)) {
    return { ok: false, error: 'content_type_mismatch', status: 415 };
  }

  const maxBytes = IMAGE_CONTENT_TYPES.has(contentType) ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (contentLength > maxBytes) {
    return { ok: false, error: 'payload_too_large', status: 413 };
  }

  if (!isValidDimension(width) || !isValidDimension(height)) {
    return { ok: false, error: 'invalid_dimensions', status: 400 };
  }

  return { ok: true, ext, contentType };
}

/**
 * Derives the content-addressed R2 key for an upload's bytes: sha256 hex
 * digest (via WebCrypto) + `.` + `ext`. Idempotent — identical bytes always
 * produce the same key, matching `SITE_MEDIA_KEY_RE` in `src/lib/site-media.ts`.
 */
export async function uploadKeyFor(bytes: UploadBytes, ext: string): Promise<string> {
  // Copy into a fresh, plain-ArrayBuffer-backed view: `crypto.subtle.digest`
  // types its input as `BufferSource`, which (per current TS DOM lib) excludes
  // a `Uint8Array` whose `buffer` is only known as `ArrayBufferLike` (i.e.
  // possibly a `SharedArrayBuffer`) — as `bytes instanceof Uint8Array` is
  // typed here. The copy is cheap and also normalizes both input shapes.
  const view = new Uint8Array(toUint8Array(bytes));
  const digest = await crypto.subtle.digest('SHA-256', view);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex}.${ext}`;
}
