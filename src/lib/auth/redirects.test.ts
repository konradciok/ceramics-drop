import { describe, it, expect } from 'vitest';
import { sanitizeNextPath } from './redirects';

describe('sanitizeNextPath', () => {
  it('accepts internal paths and keeps path + query', () => {
    expect(sanitizeNextPath('/konto')).toBe('/konto');
    expect(sanitizeNextPath('/en/konto/zamowienia/abc?x=1')).toBe('/en/konto/zamowienia/abc?x=1');
  });

  it('drops the hash fragment', () => {
    expect(sanitizeNextPath('/konto#frag')).toBe('/konto');
  });

  it('accepts an absolute URL only on the site origin, reduced to its path', () => {
    expect(sanitizeNextPath('https://anna-ciok.studio/konto?a=b')).toBe('/konto?a=b');
  });

  it.each([
    ['other-origin absolute URL', 'https://evil.example/konto'],
    ['protocol-relative URL', '//evil.example/x'],
    ['backslash smuggling (browser-normalized to //)', '/\\evil.example'],
    ['leading backslash', '\\evil.example'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['control character', '/konto\u0001'],
    ['newline', '/konto\nSet-Cookie: x=1'],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('rejects %s', (_label, value) => {
    expect(sanitizeNextPath(value)).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(sanitizeNextPath(null)).toBeNull();
    expect(sanitizeNextPath(undefined)).toBeNull();
    expect(sanitizeNextPath(42)).toBeNull();
    expect(sanitizeNextPath(['/konto'])).toBeNull();
  });
});
