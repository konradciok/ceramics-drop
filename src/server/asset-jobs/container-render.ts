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
}

/** Injected effects — the real ones are `env.PRINT_ASSETS` and the container's TCP port. */
export interface RenderDeps {
  bucket: Pick<R2Bucket, 'get' | 'put'>;
  /** `ctx.container.getTcpPort(CONTAINER_PORT).fetch` in production. */
  containerFetch: (url: string, init: ContainerRequestInit) => Promise<Response>;
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
 * byte-identical output and re-writes the SAME key. That is why this does a
 * plain `put` rather than the CLI's conditional `If-None-Match: *` PUT
 * (`scripts/lib/r2.ts`'s r2PutIfAbsent): R2 BINDINGS expose no conditional
 * write, and an unconditional overwrite of a content-addressed key with the
 * same bytes is a no-op in effect. The CLI's stronger "never overwrite"
 * guarantee exists because an operator can mix revisions by hand; this path
 * cannot.
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
    });
  } catch (e) {
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
    await deps.bucket.put(r2Key, response.body, { httpMetadata: { contentType } });
  } catch (e) {
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
