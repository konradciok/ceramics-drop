import { describe, it, expect } from 'vitest';
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
});
