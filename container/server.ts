/**
 * The Cloudflare Container's own entry point — Priority 8 / Phase 3.
 *
 * This is the ONLY process in the whole pipeline that runs real Node and real
 * Sharp. It is a deliberately dumb, stateless bytes-in/bytes-out HTTP service:
 *
 *   GET  /health          → 200 {"ok":true}
 *   POST /v1/derivative   → one exact-pixel print derivative
 *
 * It has NO database access, NO R2 access, and NO outbound network at all (the
 * Durable Object starts it with `enableInternet: false`). Everything that
 * depends on catalogue state — which profiles to render, what revision to stage
 * under, what to write where — was decided Worker-side before the bytes ever
 * got here (src/server/asset-jobs/{profiles,container-render}.ts). That keeps
 * the blast radius of the one component that decodes untrusted image bytes as
 * small as it can be.
 *
 * All render logic lives in `src/server/print-assets/container-handler.ts`
 * (unit-tested with real Sharp); this file is only transport. Keep it that way
 * — nothing here can be exercised by a test without a live container.
 */

import http from 'node:http';
import {
  DERIVATIVE_PATH,
  HEALTH_PATH,
  ProtocolError,
  SPEC_HEADER,
  decodeDerivativeSpec,
  encodeResultHeaders,
  type DerivativeSpec,
} from '../src/server/asset-jobs/container-protocol';
import { contentTypeForFormat } from '../src/lib/print-assets-prepare';
import { PermanentInputError, renderFullBleedDerivative } from '../src/server/print-assets/container-handler';

const PORT = Number(process.env.PORT ?? 8080);

function log(event: string, fields: Record<string, unknown>): void {
  // Single-line JSON, the same shape worker.ts's queue handlers log in, so both
  // sides of the boundary read identically in Workers Logs.
  console.log(JSON.stringify({ event, ...fields }));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Buffer the request body, failing closed the moment it exceeds the declared budget. */
async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new PermanentInputError('SOURCE_TOO_LARGE', `source exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === HEALTH_PATH) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST' || url !== DERIVATIVE_PATH) {
      sendJson(res, 404, { code: 'NOT_FOUND', message: `no route for ${req.method} ${url}` });
      return;
    }

    let spec: DerivativeSpec;
    try {
      spec = decodeDerivativeSpec(req.headers[SPEC_HEADER] as string | undefined);
    } catch (e) {
      const message = e instanceof ProtocolError ? e.message : String(e);
      req.resume(); // drain so the socket can be reused rather than reset mid-upload
      sendJson(res, 422, { code: 'BAD_SPEC', message });
      return;
    }

    const startedAt = Date.now();
    try {
      const source = await readBody(req, spec.maxSourceBytes);
      const result = await renderFullBleedDerivative(spec, source);
      log('container_derivative_ok', {
        jobId: spec.jobId,
        uploadId: spec.uploadId,
        profile: `${spec.target.w}x${spec.target.h}`,
        byteSize: result.byteSize,
        ms: Date.now() - startedAt,
      });
      res.writeHead(200, {
        ...encodeResultHeaders({
          sha256: result.sha256,
          byteSize: result.byteSize,
          width: spec.target.w,
          height: spec.target.h,
          format: result.format,
        }),
        'content-type': contentTypeForFormat(result.format),
        'content-length': result.byteSize,
      });
      res.end(result.buffer);
    } catch (e) {
      if (e instanceof PermanentInputError) {
        log('container_derivative_rejected', { jobId: spec.jobId, uploadId: spec.uploadId, code: e.code, message: e.message });
        req.resume();
        sendJson(res, 422, { code: e.code, message: e.message });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      log('container_derivative_failed', { jobId: spec.jobId, uploadId: spec.uploadId, message });
      req.resume();
      sendJson(res, 500, { code: 'RENDER_FAILED', message });
    }
  })();
});

// No transport-level timeout: a standard-3 render of a 160 MP master can
// legitimately run for minutes, and the Worker side owns the deadline (its own
// container fetch is what gives up first).
server.requestTimeout = 0;
server.headersTimeout = 0;

server.listen(PORT, () => log('container_listening', { port: PORT }));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('container_shutdown', { signal });
    server.close(() => process.exit(0));
  });
}
