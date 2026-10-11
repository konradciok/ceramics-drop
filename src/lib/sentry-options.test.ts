import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyUserAgent, scrubSentryEvent, stripServerUserAgent } from './sentry-options';

const PETALBOT =
  'Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (HTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)';

describe('classifyUserAgent', () => {
  it('classifies crawlers, HTTP clients and monitors as bots', () => {
    for (const ua of [
      PETALBOT,
      'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
      'Faraday v2.14.3',
      'SentryUptimeBot/1.0 (+http://docs.sentry.io/product/alerts/uptime-monitoring/)',
      'Python/3.11 aiohttp/3.9.1',
      'Go-http-client/1.1',
    ]) {
      expect(classifyUserAgent(ua), ua).toBe('bot');
    }
  });
  it('classifies ordinary browsers (old versions included) as browser, and handles absence', () => {
    expect(
      classifyUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36'),
    ).toBe('browser');
    expect(classifyUserAgent(undefined)).toBe('none');
    expect(classifyUserAgent('SomethingElse/1.0')).toBe('other');
  });
});

describe('stripServerUserAgent', () => {
  it('removes User-Agent and UA client hints (any casing) so inbound filters cannot drop the event', () => {
    const e = stripServerUserAgent({
      request: {
        headers: { 'User-Agent': PETALBOT, 'Sec-CH-UA': '"Chromium";v="101"', 'sec-ch-ua-platform': '"Android"', accept: 'text/html' },
      },
    } as never) as { request: { headers: Record<string, string> }; tags: Record<string, string>; contexts: Record<string, unknown> };
    expect(e.request.headers).toEqual({ accept: 'text/html' });
    expect(e.tags.ua_class).toBe('bot');
    expect(e.contexts.client_user_agent).toEqual({ value: PETALBOT, class: 'bot' });
  });
  it('keeps existing tags and contexts', () => {
    const e = stripServerUserAgent({
      tags: { supabaseTimeoutLabel: 'ceramic-catalog' },
      contexts: { runtime: { name: 'workerd' } },
      request: { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)' } },
    } as never) as { tags: Record<string, string>; contexts: Record<string, unknown> };
    expect(e.tags).toEqual({ supabaseTimeoutLabel: 'ceramic-catalog', ua_class: 'browser' });
    expect(e.contexts.runtime).toEqual({ name: 'workerd' });
  });
  it('leaves events without request headers untouched', () => {
    const event = { message: 'cron sweep failed' };
    expect(stripServerUserAgent(event as never)).toEqual({ message: 'cron sweep failed' });
  });
});

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
    return { ...mod.getBaseSentryOptions(), isSentryEnabled: mod.isSentryEnabled() };
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

  it('does not send from local dev unless NEXT_PUBLIC_SENTRY_SEND_IN_DEV=1 (keeps E2E/dev runs out of the prod project)', async () => {
    expect((await load({ NODE_ENV: 'development', NEXT_PUBLIC_SENTRY_SEND_IN_DEV: undefined })).enabled).toBe(false);
    expect((await load({ NODE_ENV: 'development', NEXT_PUBLIC_SENTRY_SEND_IN_DEV: '1' })).enabled).toBe(true);
    expect((await load({ NODE_ENV: 'production' })).enabled).toBe(true);
  });

  it('server options strip the UA after the base scrub; the browser (base) options do not', async () => {
    vi.resetModules();
    vi.stubEnv('SENTRY_DSN', 'https://k@o.ingest.sentry.io/1');
    vi.stubEnv('NODE_ENV', 'production');
    const mod = await import('./sentry-options');
    const event = () =>
      ({ request: { cookies: { sb: 'x' }, headers: { 'User-Agent': PETALBOT, Cookie: 'x' } } }) as never;

    const server = mod.getServerSentryOptions().beforeSend!(event(), {}) as {
      request: { cookies?: unknown; headers: Record<string, string> };
      tags: Record<string, string>;
    };
    expect(server.request.cookies).toBeUndefined();
    expect(server.request.headers).toEqual({});
    expect(server.tags.ua_class).toBe('bot');

    const browser = mod.getBaseSentryOptions().beforeSend!(event(), {}) as {
      request: { headers: Record<string, string> };
    };
    expect(browser.request.headers['User-Agent']).toBe(PETALBOT);
  });

  it('isSentryEnabled() agrees with the gate so the entrypoints skip init in dev entirely', async () => {
    expect((await load({ NODE_ENV: 'development', NEXT_PUBLIC_SENTRY_SEND_IN_DEV: undefined })).isSentryEnabled).toBe(false);
    expect((await load({ NODE_ENV: 'development', NEXT_PUBLIC_SENTRY_SEND_IN_DEV: '1' })).isSentryEnabled).toBe(true);
    expect((await load({ NODE_ENV: 'production' })).isSentryEnabled).toBe(true);
  });
});
