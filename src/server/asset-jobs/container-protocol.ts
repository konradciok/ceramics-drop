/**
 * The Worker ↔ Container wire protocol for Priority 8 / Phase 3.
 *
 * This is the ONE module imported by BOTH sides of the boundary:
 *   - the Workers side (src/server/asset-jobs/container.ts, container-render.ts,
 *     process-job.ts), which runs in the V8 isolate;
 *   - the Container side (container/server.ts), which runs real Node + Sharp.
 *
 * It therefore MUST stay free of Sharp, of `node:*`, and of any Workers-only
 * global. Everything here is pure string/JSON work over Web-standard APIs
 * (TextEncoder/atob/btoa) that both runtimes have.
 *
 * ── Shape of the exchange ────────────────────────────────────────────────────
 * One HTTP request per derivative (the master plan's "profile przetwarzane
 * kolejno" — profiles processed sequentially, one job at a time):
 *
 *   POST /v1/derivative
 *     x-derivative-spec: <base64url(JSON DerivativeSpec)>
 *     content-type:      image/jpeg | image/png
 *     body:              the SOURCE bytes, streamed straight from R2
 *
 *   200 OK
 *     x-derivative-sha256 / -byte-size / -width / -height / -format
 *     content-type: image/jpeg | image/png
 *     body: the DERIVATIVE bytes
 *
 *   422 { code, message }  → permanent (bad input: undecodable, wrong ratio,
 *                            would upscale, over the pixel/byte budget)
 *   5xx { code, message }  → retryable (container fault)
 *
 * Why the result metadata travels in RESPONSE HEADERS rather than a JSON
 * envelope: `print_fulfilment_assets.r2_key` is content-addressed
 * (prints/{product}/{revision}/{w}x{h}-{sha256}.{ext}), so the Worker must know
 * the sha256 BEFORE it can choose the key it writes to. Headers arrive ahead of
 * the body, so the Worker can read them, build the key, and then stream the
 * body straight into `R2Bucket.put` — never buffering a multi-hundred-megabyte
 * derivative inside the 128 MiB Workers isolate. A JSON envelope with a
 * base64 body would force exactly that buffering; HTTP trailers would arrive
 * too late.
 */

import type { DerivativeFormat } from '@/lib/print-assets-prepare';

/** Port the container's HTTP server listens on (must match container/Dockerfile's EXPOSE). */
export const CONTAINER_PORT = 8080;

export const HEALTH_PATH = '/health';
export const DERIVATIVE_PATH = '/v1/derivative';

/**
 * Hostname used for the container-bound Request URL. `Fetcher.fetch` needs an
 * absolute URL; the container's own HTTP server only ever looks at the path, so
 * the authority is arbitrary — fixed here so both sides agree and nothing
 * accidentally resolves a real host.
 */
export const CONTAINER_ORIGIN = 'http://print-asset-processor.internal';

export const SPEC_HEADER = 'x-derivative-spec';

export const RESULT_HEADER = {
  sha256: 'x-derivative-sha256',
  byteSize: 'x-derivative-byte-size',
  width: 'x-derivative-width',
  height: 'x-derivative-height',
  format: 'x-derivative-format',
} as const;

export type SourceContentType = 'image/jpeg' | 'image/png';

/**
 * Everything the container needs to produce ONE derivative. Deliberately
 * self-contained: the container has no database, no R2 binding and no
 * knowledge of jobs — it is a pure bytes-in/bytes-out image service, and every
 * decision that depends on catalogue state was already made Worker-side.
 */
export interface DerivativeSpec {
  /** Echoed into container logs only — never used for control flow. */
  jobId: string;
  uploadId: string;
  sourceContentType: SourceContentType;
  /** The ratio the upload row DECLARED ('3x4' | '5x7' | '7x10' | '2x3'); the container re-checks the real pixels against it. */
  expectedRatio: string;
  /** Exact output pixels — a variant's print area (product_variants.print_area_*_px). */
  target: { w: number; h: number };
  format: DerivativeFormat;
  /** Hard ceilings the container enforces on the DECODED source (master plan: 100 MiB / 160 MP). */
  maxSourceBytes: number;
  maxSourcePixels: number;
}

/** Master plan §S3: "Początkowy limit źródła: 100 MiB i 160 megapikseli, egzekwowany serwerowo." */
export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = 160_000_000;

export interface DerivativeMetadata {
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  format: DerivativeFormat;
}

/** Thrown by every parse/decode below — always a PERMANENT (never retried) condition. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// ── base64url (ASCII-safe on both runtimes) ──────────────────────────────────

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new ProtocolError(`${SPEC_HEADER} is not valid base64url`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeDerivativeSpec(spec: DerivativeSpec): string {
  return toBase64Url(JSON.stringify(spec));
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolError(`DerivativeSpec.${field} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInt(record: Record<string, unknown>, field: string, prefix = ''): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ProtocolError(`DerivativeSpec.${prefix}${field} must be a positive integer`);
  }
  return value;
}

/**
 * Strict decode — the container trusts NOTHING it is sent. A malformed spec is
 * a bug on the Worker side, not a transient fault, so it is always reported as
 * 422/permanent rather than retried forever.
 */
export function decodeDerivativeSpec(raw: string | null | undefined): DerivativeSpec {
  if (!raw) throw new ProtocolError(`${SPEC_HEADER} header is missing`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    throw new ProtocolError(`${SPEC_HEADER} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError('DerivativeSpec must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;

  const sourceContentType = requireString(record, 'sourceContentType');
  if (sourceContentType !== 'image/jpeg' && sourceContentType !== 'image/png') {
    throw new ProtocolError(`DerivativeSpec.sourceContentType must be image/jpeg or image/png`);
  }
  const format = requireString(record, 'format');
  if (format !== 'jpg' && format !== 'png') {
    throw new ProtocolError('DerivativeSpec.format must be "jpg" or "png"');
  }
  const target = record.target;
  if (typeof target !== 'object' || target === null) {
    throw new ProtocolError('DerivativeSpec.target must be an object');
  }
  const targetRecord = target as Record<string, unknown>;

  return {
    jobId: requireString(record, 'jobId'),
    uploadId: requireString(record, 'uploadId'),
    sourceContentType,
    expectedRatio: requireString(record, 'expectedRatio'),
    target: {
      w: requirePositiveInt(targetRecord, 'w', 'target.'),
      h: requirePositiveInt(targetRecord, 'h', 'target.'),
    },
    format,
    maxSourceBytes: requirePositiveInt(record, 'maxSourceBytes'),
    maxSourcePixels: requirePositiveInt(record, 'maxSourcePixels'),
  };
}

export function encodeResultHeaders(meta: DerivativeMetadata): Record<string, string> {
  return {
    [RESULT_HEADER.sha256]: meta.sha256,
    [RESULT_HEADER.byteSize]: String(meta.byteSize),
    [RESULT_HEADER.width]: String(meta.width),
    [RESULT_HEADER.height]: String(meta.height),
    [RESULT_HEADER.format]: meta.format,
  };
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Parse the result headers off a 200 response. `getHeader` is passed in (rather
 * than a Headers object) so this is callable from the container-side tests and
 * from Node without a Workers Headers implementation.
 */
export function parseResultHeaders(getHeader: (name: string) => string | null | undefined): DerivativeMetadata {
  const sha256 = getHeader(RESULT_HEADER.sha256);
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    throw new ProtocolError(`${RESULT_HEADER.sha256} is missing or not lowercase 64-hex`);
  }
  const readInt = (name: string): number => {
    const raw = getHeader(name);
    const parsed = Number(raw);
    if (typeof raw !== 'string' || raw.length === 0 || !Number.isInteger(parsed) || parsed <= 0) {
      throw new ProtocolError(`${name} is missing or not a positive integer`);
    }
    return parsed;
  };
  const format = getHeader(RESULT_HEADER.format);
  if (format !== 'jpg' && format !== 'png') {
    throw new ProtocolError(`${RESULT_HEADER.format} must be "jpg" or "png"`);
  }
  return {
    sha256,
    byteSize: readInt(RESULT_HEADER.byteSize),
    width: readInt(RESULT_HEADER.width),
    height: readInt(RESULT_HEADER.height),
    format,
  };
}

/**
 * How a container response status maps onto this pipeline's two failure
 * classes (which are print_asset_jobs' two failure statuses):
 *
 *   'permanent' → failed_action_required. The bytes will never process. An
 *                 operator must upload a different file. Retrying wastes a
 *                 container wake-up per attempt and ends in the DLQ anyway.
 *   'retryable' → failed_retryable + rethrow, so Task 10's existing
 *                 backoff/DLQ machinery handles it unchanged.
 *
 * 408/429 are deliberately RETRYABLE despite being 4xx: they describe the
 * container's momentary capacity ("one job at a time"), not the input.
 */
export type ContainerOutcomeClass = 'ok' | 'permanent' | 'retryable';

export function classifyContainerStatus(status: number): ContainerOutcomeClass {
  if (status === 200) return 'ok';
  if (status === 408 || status === 429) return 'retryable';
  if (status >= 400 && status < 500) return 'permanent';
  return 'retryable';
}

/** Error body both sides use for non-200 responses. */
export interface ContainerErrorBody {
  code: string;
  message: string;
}

export function parseContainerErrorBody(text: string, status: number): ContainerErrorBody {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const code = typeof parsed.code === 'string' && parsed.code ? parsed.code : `HTTP_${status}`;
    const message = typeof parsed.message === 'string' && parsed.message ? parsed.message : text.slice(0, 500);
    return { code, message };
  } catch {
    return { code: `HTTP_${status}`, message: text.slice(0, 500) || `container returned ${status}` };
  }
}
