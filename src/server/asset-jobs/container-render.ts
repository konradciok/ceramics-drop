/**
 * Worker-side half of the Container boundary: R2 in → container → R2 out.
 *
 * Split out of `container.ts` (which holds the Durable Object class, and can
 * therefore only be imported by `worker.ts`) so that ALL of the decision logic
 * — key construction, error classification, the staged-row shape — is plain
 * testable code with injected effects. The only thing `container.ts` adds on
 * top is "start the container and hand me its port".
 *
 * This module must never import Sharp or `src/server/print-assets/derivatives.ts`:
 * it runs in the Workers V8 isolate. The Sharp side of this exchange is
 * `container/server.ts`.
 *
 * ── Streaming discipline ─────────────────────────────────────────────────────
 * Neither the source nor the derivative is ever buffered in the isolate:
 * `R2ObjectBody.body` is piped straight into the container request, and the
 * container response body is piped straight into `R2Bucket.put`. That is what
 * keeps a 100 MiB source and a multi-hundred-megapixel derivative inside the
 * Workers 128 MiB memory limit.
 */

import {
  buildR2Key,
  contentTypeForFormat,
  profileKeyFromPx,
  type DerivativeFormat,
} from '@/lib/print-assets-prepare';
import type { StagedAssetRow } from '@/lib/print-assets-publish';
import {
  CONTAINER_ORIGIN,
  DERIVATIVE_PATH,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PIXELS,
  ProtocolError,
  SPEC_HEADER,
  classifyContainerStatus,
  encodeDerivativeSpec,
  parseContainerErrorBody,
  parseResultHeaders,
  type DerivativeSpec,
  type SourceContentType,
} from './container-protocol';

/**
 * The container request, as a URL + init pair rather than a constructed
 * `Request`. Deliberate: a `Request` with a ReadableStream body is illegal in
 * Node's undici without `duplex: 'half'` (a field the Workers `RequestInit`
 * type does not declare), so building one here would make this module
 * untestable under vitest for no benefit — `Fetcher.fetch(url, init)` takes the
 * pair directly.
 */
export interface ContainerRequestInit {
  method: 'POST';
  headers: Record<string, string>;
  body: ReadableStream;
  /**
   * The render deadline. The container deliberately sets no transport timeout
   * of its own (`container/server.ts` zeroes `requestTimeout`/`headersTimeout`,
   * because a legitimate 160 MP render can run for minutes) — so THIS is the
   * only thing that stops a wedged render from stranding its job forever and,
   * through the Durable Object's exclusive-run chain, blocking every profile
   * queued behind it.
   */
  signal: AbortSignal;
}

/**
 * Wall-clock ceiling on one derivative. Generous: the plan's own sizing is a
 * single `standard-3` (2 vCPU) processing one job at a time, and a 160 MP
 * master legitimately takes minutes. It exists to bound a HANG, not to police
 * slowness — a render that hits this is reported retryable, so the queue's
 * normal backoff/DLQ machinery takes over.
 */
export const RENDER_TIMEOUT_MS = 10 * 60 * 1000;

/** Injected effects — the real ones are `env.PRINT_ASSETS` and the container's TCP port. */
export interface RenderDeps {
  bucket: Pick<R2Bucket, 'get' | 'put'>;
  /** `ctx.container.getTcpPort(CONTAINER_PORT).fetch` in production. */
  containerFetch: (url: string, init: ContainerRequestInit) => Promise<Response>;
  /** Injectable purely so tests need not burn real time; defaults to AbortSignal.timeout. */
  renderSignal?: () => AbortSignal;
}

export interface RenderInput {
  jobId: string;
  uploadId: string;
  productId: string;
  /** print_fulfilment_assets.revision — see profiles.ts's assetRevisionForUpload. */
  revision: string;
  /** print_asset_uploads.r2_key (uploads/{id}.{jpg|png}). */
  sourceKey: string;
  sourceContentType: SourceContentType;
  /** print_asset_uploads.ratio, already validated as a PrintRatio by the caller. */
  expectedRatio: string;
  target: { w: number; h: number };
  format: DerivativeFormat;
}

export type RenderResult =
  /** The derivative exists in R2 under `asset.r2_key` and is ready to stage. */
  | { kind: 'ok'; asset: StagedAssetRow }
  /** Terminal: the input can never produce this derivative. → failed_action_required */
  | { kind: 'permanent'; code: string; message: string }
  /** Transient: container/R2 fault. → failed_retryable + rethrow, so Task 10's backoff/DLQ applies. */
  | { kind: 'retryable'; code: string; message: string };

export function buildDerivativeSpec(input: RenderInput): DerivativeSpec {
  return {
    jobId: input.jobId,
    uploadId: input.uploadId,
    sourceContentType: input.sourceContentType,
    expectedRatio: input.expectedRatio,
    target: input.target,
    format: input.format,
    maxSourceBytes: MAX_SOURCE_BYTES,
    maxSourcePixels: MAX_SOURCE_PIXELS,
  };
}

/**
 * Render ONE profile and persist it under its content-addressed key.
 *
 * Idempotent by construction: the key embeds the derivative's own sha256, and
 * `composeFullBleedDerivative` is deterministic, so a retried job re-derives
 * byte-identical output and re-writes the SAME key.
 *
 * ── Why an UNCONDITIONAL put ─────────────────────────────────────────────────
 * R2 bindings DO expose a conditional write — `R2PutOptions.onlyIf` (an
 * `R2Conditional`, e.g. `{ etagDoesNotMatch: '*' }`) is the binding-level
 * equivalent of the `If-None-Match: *` PUT the CLI's `scripts/lib/r2.ts`
 * `r2PutIfAbsent` issues through the S3 API. This path deliberately does not
 * use it: a conditional write would REFUSE to overwrite, which is the wrong
 * behaviour here, because a previous attempt can legitimately have left a
 * TRUNCATED object under this key (container OOM or reset after the response
 * headers were already sent). An unconditional re-put heals that; a conditional
 * one would cement the corruption forever under an immutable content-addressed
 * key. The CLI's stronger "never overwrite" posture exists because an operator
 * can mix revisions by hand — this path cannot.
 *
 * Integrity is instead enforced by `R2PutOptions.sha256`: R2 hashes the bytes
 * it actually receives server-side and REJECTS the write if the digest does not
 * match the one the container claimed. Without it, a truncated response body
 * would be stored happily under a key asserting a hash it does not have, and
 * the job would complete "successfully" with a corrupt asset.
 */
export async function renderAndStoreDerivative(deps: RenderDeps, input: RenderInput): Promise<RenderResult> {
  let source: R2ObjectBody | null;
  try {
    source = await deps.bucket.get(input.sourceKey);
  } catch (e) {
    return { kind: 'retryable', code: 'R2_GET_FAILED', message: `R2 get failed for ${input.sourceKey}: ${String(e)}` };
  }
  if (!source) {
    return { kind: 'permanent', code: 'SOURCE_MISSING', message: `R2 object missing for ${input.sourceKey}` };
  }

  const spec = buildDerivativeSpec(input);
  let response: Response;
  try {
    response = await deps.containerFetch(`${CONTAINER_ORIGIN}${DERIVATIVE_PATH}`, {
      method: 'POST',
      headers: {
        [SPEC_HEADER]: encodeDerivativeSpec(spec),
        'content-type': input.sourceContentType,
      },
      body: source.body,
      signal: (deps.renderSignal ?? (() => AbortSignal.timeout(RENDER_TIMEOUT_MS)))(),
    });
  } catch (e) {
    // A timeout is reported separately from a connection failure: both are
    // retryable, but "the container wedged on this image" and "the container is
    // not answering at all" are different operational stories in the job's
    // last_error.
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        kind: 'retryable',
        code: 'CONTAINER_TIMEOUT',
        message: `container render exceeded ${RENDER_TIMEOUT_MS}ms for profile ${input.target.w}x${input.target.h}`,
      };
    }
    return { kind: 'retryable', code: 'CONTAINER_UNREACHABLE', message: `container fetch failed: ${String(e)}` };
  }

  const outcome = classifyContainerStatus(response.status);
  if (outcome !== 'ok') {
    const text = await response.text().catch(() => '');
    const body = parseContainerErrorBody(text, response.status);
    return { kind: outcome, code: body.code, message: body.message };
  }

  let meta;
  try {
    meta = parseResultHeaders((name) => response.headers.get(name));
  } catch (e) {
    // A 200 with unreadable metadata is a container-side bug, not bad input —
    // but retrying identical bytes through the identical build will produce the
    // identical broken response, so it is terminal, not retryable.
    const message = e instanceof ProtocolError ? e.message : String(e);
    return { kind: 'permanent', code: 'CONTAINER_BAD_RESPONSE', message };
  }
  if (meta.width !== input.target.w || meta.height !== input.target.h) {
    return {
      kind: 'permanent',
      code: 'CONTAINER_BAD_RESPONSE',
      message: `container returned ${meta.width}x${meta.height} for target ${input.target.w}x${input.target.h}`,
    };
  }
  if (!response.body) {
    return { kind: 'permanent', code: 'CONTAINER_BAD_RESPONSE', message: 'container returned 200 with no body' };
  }

  const contentType = contentTypeForFormat(meta.format);
  const r2Key = buildR2Key(input.productId, input.revision, meta.width, meta.height, meta.sha256, meta.format);
  try {
    // `sha256` closes the content-addressing loop: R2 hashes what it actually
    // receives and rejects the write on a mismatch, so a body that truncates
    // after the headers were sent can never be stored under a key asserting a
    // digest it does not have. Without this, the loop asserts integrity it
    // never checks.
    await deps.bucket.put(r2Key, response.body, { httpMetadata: { contentType }, sha256: meta.sha256 });
  } catch (e) {
    // Includes R2's own digest-mismatch rejection. Retryable, not permanent: a
    // truncated transfer is exactly the kind of fault a retry fixes, and the
    // unconditional re-put then heals any short object already at the key.
    return { kind: 'retryable', code: 'R2_PUT_FAILED', message: `R2 put failed for ${r2Key}: ${String(e)}` };
  }

  return {
    kind: 'ok',
    asset: {
      product_id: input.productId,
      revision: input.revision,
      profile_key: profileKeyFromPx(meta.width, meta.height),
      r2_key: r2Key,
      sha256: meta.sha256,
      content_type: contentType,
      width_px: meta.width,
      height_px: meta.height,
      byte_size: meta.byteSize,
      status: 'staged',
    },
  };
}
