import { describe, it, expect, vi, afterEach } from 'vitest';
import { scrubSentryEvent } from './sentry-options';

describe('scrubSentryEvent', () => {
  it('drops request cookies and sensitive headers regardless of casing', () => {
    const e = scrubSentryEvent({
      request: {
        cookies: { sb: 'secret' },
        // Mixed casing on purpose — case-insensitive scrub must still remove them.
        headers: { Cookie: 'x', Authorization: 'Bearer y', 'X-Forwarded-For': '1.2.3.4', 'x-ok': 'keep' },
      },
    } as never) as { request: { cookies?: unknown; headers: Record<string, string> } };
    expect(e.request.cookies).toBeUndefined();
    expect(e.request.headers.Cookie).toBeUndefined();
    expect(e.request.headers.Authorization).toBeUndefined();
    expect(e.request.headers['X-Forwarded-For']).toBeUndefined();
    expect(e.request.headers['x-ok']).toBe('keep');
  });
  it('truncates oversized extra strings but leaves short/non-strings', () => {
    const big = 'a'.repeat(5000);
    const e = scrubSentryEvent({ extra: { big, small: 'ok', n: 5 } } as never) as {
      extra: Record<string, unknown>;
    };
    expect((e.extra.big as string).length).toBeLessThan(big.length);
    expect(e.extra.small).toBe('ok');
    expect(e.extra.n).toBe(5);
  });
  it('strips the query string + fragment from request.url and drops query_string (token vectors)', () => {
    const e = scrubSentryEvent({
      request: {
        url: 'https://x.test/koszyk/return?payment_intent_client_secret=secret&sale=tok#frag',
        query_string: 'sale=tok',
      },
    } as never) as { request: { url: string; query_string?: unknown } };
    expect(e.request.url).toBe('https://x.test/koszyk/return');
    expect(e.request.query_string).toBeUndefined();
  });
});

describe('getBaseSentryOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(env: Record<string, string | undefined>) {
    vi.resetModules();
    vi.stubEnv('SENTRY_DSN', 'https://k@o.ingest.sentry.io/1');
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
    const mod = await import('./sentry-options');
    return mod.getBaseSentryOptions();
  }

  it('ignores the Instagram in-app browser bridge errors (not our code)', async () => {
    const opts = await load({ NODE_ENV: 'production' });
    const patterns = (opts.ignoreErrors ?? []) as RegExp[];
    for (const msg of [
      'Error: 454: Handling is disabled',
      'Error: Error invoking postMessage: Java exception was raised during method invocation',
      "TypeError: undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      'Java object is gone',
    ]) {
      expect(patterns.some((p) => (p instanceof RegExp ? p.test(msg) : msg.includes(String(p)))), msg).toBe(true);
    }
  });

  it('does not send from local dev unless SENTRY_SEND_IN_DEV=1 (keeps E2E/dev runs out of the prod project)', async () => {
    expect((await load({ NODE_ENV: 'development', SENTRY_SEND_IN_DEV: undefined })).enabled).toBe(false);
    expect((await load({ NODE_ENV: 'development', SENTRY_SEND_IN_DEV: '1' })).enabled).toBe(true);
    expect((await load({ NODE_ENV: 'production' })).enabled).toBe(true);
  });
});
