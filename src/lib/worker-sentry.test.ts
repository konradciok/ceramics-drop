import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSentryDsn, buildEventEnvelope, captureWorkerAlert } from './worker-sentry';

describe('parseSentryDsn', () => {
  it('parses a standard DSN', () => {
    expect(parseSentryDsn('https://abc123@o42.ingest.sentry.io/98765')).toEqual({
      host: 'o42.ingest.sentry.io',
      projectId: '98765',
      publicKey: 'abc123',
    });
  });
  it('ignores a legacy secret in the DSN userinfo', () => {
    expect(parseSentryDsn('https://pub:sec@host.example/7')?.publicKey).toBe('pub');
  });
  it('returns null for a malformed DSN (no key / no project)', () => {
    expect(parseSentryDsn('https://host.example/7')).toBeNull();
    expect(parseSentryDsn('https://abc@host.example/')).toBeNull();
    expect(parseSentryDsn('not a url')).toBeNull();
  });
});

describe('buildEventEnvelope', () => {
  const dsn = 'https://abc123@o42.ingest.sentry.io/98765';
  const opts = { eventId: 'deadbeef'.repeat(4), nowIso: '2026-08-12T10:00:00.000Z' };

  it('emits exactly three newline-delimited lines: envelope header, item header, payload', () => {
    const env = buildEventEnvelope(dsn, { message: 'boom', level: 'error' }, opts);
    const lines = env.split('\n');
    expect(lines).toHaveLength(3);
    const [header, itemHeader, payload] = lines.map((l) => JSON.parse(l));
    expect(header).toEqual({ event_id: opts.eventId, dsn, sent_at: opts.nowIso });
    expect(itemHeader).toEqual({ type: 'event', content_type: 'application/json' });
    expect(payload.message).toBe('boom');
    expect(payload.level).toBe('error');
    expect(payload.timestamp).toBe(opts.nowIso);
    expect(payload.event_id).toBe(opts.eventId);
  });

  it('tags the event runtime:worker-handler and merges extra + custom tags', () => {
    const env = buildEventEnvelope(
      dsn,
      { message: 'x', extra: { orderId: 'ord-1' }, tags: { kind: 'stalled' } },
      opts,
    );
    const payload = JSON.parse(env.split('\n')[2]);
    expect(payload.tags).toEqual({ runtime: 'worker-handler', kind: 'stalled' });
    expect(payload.extra).toEqual({ orderId: 'ord-1' });
    expect(payload.level).toBe('error'); // default
  });
});

describe('captureWorkerAlert', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('no-ops (no fetch) when SENTRY_DSN is unset — fail-soft in dev/preview', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;
    await captureWorkerAlert({} as CloudflareEnv, { message: 'x' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs the envelope to the derived ingestion URL with the right content-type', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchSpy as never;
    await captureWorkerAlert(
      { SENTRY_DSN: 'https://abc123@o42.ingest.sentry.io/98765' } as CloudflareEnv,
      { message: 'stalled job', level: 'error', extra: { jobId: 'j1' } },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      'https://o42.ingest.sentry.io/api/98765/envelope/?sentry_key=abc123&sentry_version=7',
    );
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-sentry-envelope');
    expect(String(init.body).split('\n')).toHaveLength(3);
  });

  it('logs worker_sentry_send_failed on a 4xx/5xx ingest rejection (fetch resolves, still fail-soft)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 })) as never;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      captureWorkerAlert(
        { SENTRY_DSN: 'https://abc123@o42.ingest.sentry.io/98765' } as CloudflareEnv,
        { message: 'x' },
      ),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"worker_sentry_send_failed"'),
    );
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('"status":500'))).toBe(true);
  });

  it('swallows a fetch error (never throws — must not block the ack/mark)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as never;
    await expect(
      captureWorkerAlert(
        { SENTRY_DSN: 'https://abc123@o42.ingest.sentry.io/98765' } as CloudflareEnv,
        { message: 'x' },
      ),
    ).resolves.toBeUndefined();
  });
});
