import { NextResponse } from 'next/server';
import { parseSentryDsn } from '@/lib/worker-sentry';

export const dynamic = 'force-dynamic';

/** Browser envelopes are a few KB; Sentry's own per-envelope ingest cap is far above this. */
export const MAX_ENVELOPE_BYTES = 1_000_000;

const UPSTREAM_TIMEOUT_MS = 8_000;
// The SDK backs off on these, so they are the only upstream headers worth relaying.
const RELAYED_RESPONSE_HEADERS = ['retry-after', 'x-sentry-rate-limits'];

function reject(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Own-project Sentry targets, read per request: `SENTRY_DSN` is a Worker secret
 * (on `process.env` at request time under OpenNext) and `NEXT_PUBLIC_SENTRY_DSN`
 * is inlined at build — the browser SDK sends the latter, so both are allowed.
 */
function allowedTargets(): { host: string; projectId: string }[] {
  return [process.env.SENTRY_DSN, process.env.NEXT_PUBLIC_SENTRY_DSN]
    .map((dsn) => (dsn ? parseSentryDsn(dsn) : null))
    .filter((t): t is NonNullable<typeof t> => t !== null);
}

/** Read the body up to `limit` bytes; null when it is larger (stops reading at the cap). */
async function readCapped(req: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return body;
}

/** The `dsn` from the envelope header (first line, JSON), or null when malformed. */
function envelopeDsn(body: Uint8Array): string | null {
  const newline = body.indexOf(0x0a);
  if (newline <= 0) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(body.subarray(0, newline))) as unknown;
    const dsn = (header as { dsn?: unknown } | null)?.dsn;
    return typeof dsn === 'string' ? dsn : null;
  } catch {
    return null;
  }
}

/**
 * First-party Sentry tunnel for the browser SDK (`tunnel` in
 * src/instrumentation-client.ts). Replaces `@sentry/nextjs`'s `tunnelRoute`
 * rewrite (audit ED-02): that rewrite took the org/project from the query
 * string — an open relay to any Sentry project — and OpenNext's proxy forwarded
 * every client header, including the HttpOnly `sb-*-auth-token` session cookies.
 * Here only envelopes addressed to our own DSN are accepted, and only the body
 * is sent upstream.
 */
export async function POST(req: Request) {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_ENVELOPE_BYTES) {
    return reject(413, 'payload_too_large');
  }
  let body: Uint8Array<ArrayBuffer> | null;
  try {
    body = await readCapped(req, MAX_ENVELOPE_BYTES);
  } catch {
    return reject(400, 'invalid_envelope');
  }
  if (!body) return reject(413, 'payload_too_large');

  const dsn = envelopeDsn(body);
  const target = dsn ? parseSentryDsn(dsn) : null;
  if (!target) return reject(400, 'invalid_envelope');
  const allowed = allowedTargets().some(
    (t) => t.host === target.host && t.projectId === target.projectId,
  );
  if (!allowed) return reject(400, 'unknown_dsn');

  let upstream: Response;
  try {
    upstream = await fetch(`https://${target.host}/api/${target.projectId}/envelope/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return reject(502, 'sentry_unreachable');
  }

  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new NextResponse(null, { status: upstream.status, headers });
}

function methodNotAllowed() {
  return NextResponse.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } },
  );
}

export { methodNotAllowed as GET, methodNotAllowed as PUT, methodNotAllowed as PATCH, methodNotAllowed as DELETE };
