import { describe, it, expect } from 'vitest';
import { normalizeGaSessionId, parseGaClientId, parseGaSessionId, resolveGaClientId } from './context';

describe('parseGaClientId', () => {
  it('extracts the client id from a _ga cookie', () => {
    expect(parseGaClientId('GA1.1.1234567890.1680000000')).toBe('1234567890.1680000000');
  });
  it('returns null for malformed or missing cookies', () => {
    expect(parseGaClientId(null)).toBeNull();
    expect(parseGaClientId('GA1.1')).toBeNull();
  });
});

describe('parseGaSessionId', () => {
  it('extracts the session id from a _ga_<id> cookie', () => {
    expect(parseGaSessionId('GS1.1.1680000300.1.1.1680000600.0.0.0')).toBe('1680000300');
  });
  it('extracts the session id from a current GS2 cookie', () => {
    expect(parseGaSessionId('GS2.1.s1795501352$o1$g1$t1795502288$j22$l0$h961439474')).toBe('1795501352');
  });
  it('returns null for malformed or missing cookies', () => {
    expect(parseGaSessionId(null)).toBeNull();
    expect(parseGaSessionId('GS1.1')).toBeNull();
    expect(parseGaSessionId('GS2.1.o1$g1')).toBeNull();
    expect(parseGaSessionId('garbage')).toBeNull();
  });
});

describe('normalizeGaSessionId', () => {
  it('keeps a bare numeric id', () => {
    expect(normalizeGaSessionId('1795501352')).toBe('1795501352');
  });
  it('recovers the id from the bare GS2 segment the old parser stored', () => {
    expect(
      normalizeGaSessionId('s1795501352$o1$g1$t1795502288$j22$l0$h961439474$dGpfJM8S1bMKbS4nMcenNiQCpa354hpYU3w'),
    ).toBe('1795501352');
  });
  it('rejects anything that is not a session id', () => {
    expect(normalizeGaSessionId(undefined)).toBeNull();
    expect(normalizeGaSessionId('')).toBeNull();
    expect(normalizeGaSessionId('12ab')).toBeNull();
    expect(normalizeGaSessionId('s$o1')).toBeNull();
  });
});

describe('resolveGaClientId', () => {
  it('returns the real _ga client_id when present', () => {
    expect(resolveGaClientId('111.222')).toBe('111.222');
  });
  it('mints a non-empty fallback when absent (so GA4 MP is not skipped)', () => {
    const a = resolveGaClientId(null);
    const b = resolveGaClientId(null);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b); // per-order, unique
  });
});
