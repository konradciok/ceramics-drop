import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripUrlParams } from './use-strip-url-token';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub window.location.href + a history.replaceState spy; returns the spy. */
function stubLocation(href: string) {
  const replaceState = vi.fn();
  vi.stubGlobal('window', {
    location: { href },
    history: { state: { k: 'v' }, replaceState },
  });
  return replaceState;
}

describe('stripUrlParams', () => {
  it('removes a present param and preserves path + other params', () => {
    const replaceState = stubLocation(
      'https://anna-ciok.studio/koszyk?sale=LEAKTEST123&foo=1',
    );
    stripUrlParams(['sale']);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith({ k: 'v' }, '', '/koszyk?foo=1');
  });

  it('removes multiple params (the Stripe return page)', () => {
    const replaceState = stubLocation(
      'https://anna-ciok.studio/koszyk/return?payment_intent=pi_123&payment_intent_client_secret=pi_123_secret_x',
    );
    stripUrlParams(['payment_intent', 'payment_intent_client_secret']);
    expect(replaceState).toHaveBeenCalledWith({ k: 'v' }, '', '/koszyk/return');
  });

  it('is a no-op when no target param is present', () => {
    const replaceState = stubLocation('https://anna-ciok.studio/kubki/k01');
    stripUrlParams(['preview']);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('does nothing on the server (no window)', () => {
    // afterEach unstubbed window → typeof window === 'undefined' here.
    expect(() => stripUrlParams(['sale'])).not.toThrow();
  });
});
