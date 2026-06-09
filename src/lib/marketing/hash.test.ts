import { describe, it, expect } from 'vitest';
import { sha256Hex, normalizeEmail, normalizePhonePl, normalizeText, hashUserField } from './hash';

describe('sha256Hex', () => {
  it('hashes a normalized email to a stable 64-char digest', async () => {
    const h = await sha256Hex('john@example.com');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(await sha256Hex('john@example.com')); // deterministic
  });
  it('produces a 64-char lowercase hex digest', async () => {
    const h = await sha256Hex('abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // SHA-256("abc") well-known vector
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  John@Example.COM ')).toBe('john@example.com');
  });
  it('returns null for blank', () => {
    expect(normalizeEmail('   ')).toBeNull();
  });
});

describe('normalizePhonePl', () => {
  it('strips non-digits and prefixes 48 for a 9-digit local number', () => {
    expect(normalizePhonePl('600 123 456')).toBe('48600123456');
  });
  it('keeps an already-prefixed number', () => {
    expect(normalizePhonePl('+48 600 123 456')).toBe('48600123456');
  });
  it('returns null for blank', () => {
    expect(normalizePhonePl('')).toBeNull();
  });
});

describe('normalizeText', () => {
  it('trims, lowercases, and removes internal whitespace for cities', () => {
    expect(normalizeText('  New York ', { stripSpaces: true })).toBe('newyork');
  });
  it('keeps internal spaces off by default', () => {
    expect(normalizeText('  Anna Maria ')).toBe('anna maria');
  });
});

describe('hashUserField', () => {
  it('returns a single-element array of the hash, or undefined for null', async () => {
    expect(await hashUserField('john@example.com', normalizeEmail)).toEqual([
      await sha256Hex('john@example.com'),
    ]);
    expect(await hashUserField(null, normalizeEmail)).toBeUndefined();
  });
});
