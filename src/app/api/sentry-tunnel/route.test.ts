import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, MAX_ENVELOPE_BYTES, POST } from './route';

const OWN_DSN = 'https://abc123@o42.ingest.de.sentry.io/98765';
const FOREIGN_DSN = 'https://evil@o1.ingest.sentry.io/1';

function envelope(dsn: unknown, rest = '{"type":"event"}\n{"message":"boom"}') {
  return `${JSON.stringify({ event_id: 'e1', dsn, sent_at: '2026-11-26T00:00:00Z' })}\n${rest}`;
}

function tunnelRequest(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request('https://anna-ciok.studio/api/sentry-tunnel', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      Cookie: 'sb-ref-auth-token=secret-session; _ga=GA1.1',
      Authorization: 'Bearer should-not-leak',
      ...headers,
    },
    body,
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv('SENTRY_DSN', '');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', OWN_DSN);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'X-Sentry-Rate-Limits': '60::organization' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/sentry-tunnel', () => {
  it('forwards only the envelope body to the own project, without client headers', async () => {
    const body = envelope(OWN_DSN);
    const res = await POST(tunnelRequest(body));

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Sentry-Rate-Limits')).toBe('60::organization');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://o42.ingest.de.sentry.io/api/98765/envelope/');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect([...headers.keys()]).toEqual(['content-type']);
    expect(headers.get('content-type')).toBe('application/x-sentry-envelope');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(body);
  });

  it('also accepts the server-only SENTRY_DSN project', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '');
    vi.stubEnv('SENTRY_DSN', OWN_DSN);
    const res = await POST(tunnelRequest(envelope(OWN_DSN)));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes the upstream status through (e.g. a 429 rate limit)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '30' } }));
    const res = await POST(tunnelRequest(envelope(OWN_DSN)));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  it('rejects a foreign DSN (open-relay attempt) with 400 and never calls Sentry', async () => {
    const res = await POST(tunnelRequest(envelope(FOREIGN_DSN)));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects the own project id on a foreign host', async () => {
    const res = await POST(tunnelRequest(envelope('https://abc123@attacker.example/98765')));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects everything when no DSN is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '');
    const res = await POST(tunnelRequest(envelope(OWN_DSN)));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no header line', '{"dsn":"' + OWN_DSN + '"'],
    ['invalid JSON header', 'not json\n{}'],
    ['header without dsn', '{"event_id":"e1"}\n{}'],
    ['non-string dsn', envelope(42)],
    ['malformed dsn', envelope('not a url')],
    ['empty body', ''],
  ])('rejects a malformed envelope (%s) with 400', async (_label, body) => {
    const res = await POST(tunnelRequest(body));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a declared Content-Length over the limit with 413 before reading', async () => {
    const res = await POST(
      tunnelRequest(envelope(OWN_DSN), { 'Content-Length': String(MAX_ENVELOPE_BYTES + 1) }),
    );
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized streamed body (no Content-Length) with 413', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_ENVELOPE_BYTES + chunk.length) return controller.close();
        if (sent === 0) controller.enqueue(new TextEncoder().encode(envelope(OWN_DSN, '{"type":"event"}\n')));
        controller.enqueue(chunk);
        sent += chunk.length;
      },
    });
    const req = new Request('https://anna-ciok.studio/api/sentry-tunnel', {
      method: 'POST',
      body: stream,
      // @ts-expect-error -- `duplex` is required by undici for a streamed body but missing from the DOM type.
      duplex: 'half',
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 502 when Sentry is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    const res = await POST(tunnelRequest(envelope(OWN_DSN)));
    expect(res.status).toBe(502);
  });
});

describe('non-POST /api/sentry-tunnel', () => {
  it('answers 405 with Allow: POST', async () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
