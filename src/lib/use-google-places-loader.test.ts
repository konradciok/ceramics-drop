import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGooglePlacesLoader, shouldLoadGooglePlaces } from './use-google-places-loader';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shouldLoadGooglePlaces', () => {
  it('returns true when consent is granted and an API key is set', () => {
    expect(shouldLoadGooglePlaces('ciok_consent=granted', 'a-key')).toBe(true);
  });

  it('returns false when consent is denied, even with a key present', () => {
    expect(shouldLoadGooglePlaces('ciok_consent=denied', 'a-key')).toBe(false);
  });

  it('returns false when consent is undecided (no cookie)', () => {
    expect(shouldLoadGooglePlaces('', 'a-key')).toBe(false);
  });

  it('returns false when consent is granted but the API key is empty/undefined', () => {
    expect(shouldLoadGooglePlaces('ciok_consent=granted', '')).toBe(false);
    expect(shouldLoadGooglePlaces('ciok_consent=granted', undefined)).toBe(false);
  });

  it('does not throw on a malformed cookie string, and returns false', () => {
    expect(() => shouldLoadGooglePlaces(';;;===garbage', 'a-key')).not.toThrow();
    expect(shouldLoadGooglePlaces(';;;===garbage', 'a-key')).toBe(false);
  });
});

/**
 * Minimal stand-in for `Document`, tracking script creation/appending so the
 * enforcement test can assert on it without jsdom (this repo's vitest runs
 * `environment: 'node'` — see use-strip-url-token.test.ts for the precedent).
 */
function stubDocument() {
  const appendedScripts: Array<{ attrs: Record<string, string> }> = [];
  const headAppendChild = vi.fn((el: { attrs: Record<string, string> }) => {
    appendedScripts.push(el);
  });
  const querySelector = vi.fn(() => null);
  const createElement = vi.fn(() => {
    const attrs: Record<string, string> = {};
    return {
      attrs,
      setAttribute: (name: string, value: string) => {
        attrs[name] = value;
      },
      set textContent(_v: string) {},
    };
  });
  const doc = {
    querySelector,
    createElement,
    head: { appendChild: headAppendChild },
  };
  return { doc, headAppendChild, querySelector, appendedScripts };
}

describe('runGooglePlacesLoader (enforcement — gate must actually block the DOM effect)', () => {
  it('appends no script and never calls importLibrary when consent is denied', async () => {
    const importLibrary = vi.fn();
    vi.stubGlobal('google', { maps: { importLibrary } });
    const { doc, headAppendChild, querySelector } = stubDocument();

    await runGooglePlacesLoader(
      'ciok_consent=denied',
      'a-key',
      doc as unknown as Document,
    );

    expect(headAppendChild).not.toHaveBeenCalled();
    expect(querySelector).not.toHaveBeenCalled();
    expect(importLibrary).not.toHaveBeenCalled();
  });

  it('appends no script and never calls importLibrary when consent is undecided', async () => {
    const importLibrary = vi.fn();
    vi.stubGlobal('google', { maps: { importLibrary } });
    const { doc, headAppendChild } = stubDocument();

    await runGooglePlacesLoader('', 'a-key', doc as unknown as Document);

    expect(headAppendChild).not.toHaveBeenCalled();
    expect(importLibrary).not.toHaveBeenCalled();
  });

  it('appends no script and never calls importLibrary when the API key is unset', async () => {
    const importLibrary = vi.fn();
    vi.stubGlobal('google', { maps: { importLibrary } });
    const { doc, headAppendChild } = stubDocument();

    await runGooglePlacesLoader(
      'ciok_consent=granted',
      undefined,
      doc as unknown as Document,
    );

    expect(headAppendChild).not.toHaveBeenCalled();
    expect(importLibrary).not.toHaveBeenCalled();
  });

  it('appends the bootstrap script and calls importLibrary("places") when the gate passes', async () => {
    const importLibrary = vi.fn().mockResolvedValue({});
    vi.stubGlobal('google', { maps: { importLibrary } });
    const { doc, headAppendChild, appendedScripts } = stubDocument();

    await runGooglePlacesLoader(
      'ciok_consent=granted',
      'a-key',
      doc as unknown as Document,
    );

    expect(headAppendChild).toHaveBeenCalledTimes(1);
    expect(appendedScripts[0]?.attrs['data-google-places']).toBe('');
    expect(importLibrary).toHaveBeenCalledWith('places');
  });

  it('does not append a second script when one is already present', async () => {
    const importLibrary = vi.fn().mockResolvedValue({});
    vi.stubGlobal('google', { maps: { importLibrary } });
    const { doc, headAppendChild, querySelector } = stubDocument();
    querySelector.mockReturnValue({} as unknown as never);

    await runGooglePlacesLoader(
      'ciok_consent=granted',
      'a-key',
      doc as unknown as Document,
    );

    expect(headAppendChild).not.toHaveBeenCalled();
    expect(importLibrary).toHaveBeenCalledWith('places');
  });
});
