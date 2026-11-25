import { describe, it, expect } from 'vitest';
import {
  sha256Hex,
  normalizeCity,
  normalizeEmail,
  normalizePhone,
  normalizePostCode,
  normalizeText,
  hashUserField,
} from './hash';

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

describe('normalizePhone', () => {
  it('strips non-digits and prefixes 48 for a 9-digit local number with no known destination', () => {
    expect(normalizePhone('600 123 456')).toBe('48600123456');
  });
  it('prefixes 48 for a 9-digit local number shipped to Poland', () => {
    expect(normalizePhone('600-123-456', 'PL')).toBe('48600123456');
  });
  it('prefixes 34 for a 9-digit local number shipped to Spain', () => {
    expect(normalizePhone('612 345 678', 'ES')).toBe('34612345678');
  });
  it('keeps an international number as typed, whatever the destination', () => {
    expect(normalizePhone('+48 600 123 456')).toBe('48600123456');
    expect(normalizePhone('+44 7700 900123', 'PL')).toBe('447700900123');
    expect(normalizePhone('0049 151 23456789', 'DE')).toBe('4915123456789');
  });
  it('never guesses a calling code for a bare number in another country', () => {
    expect(normalizePhone('015123456789', 'DE')).toBe('015123456789');
    expect(normalizePhone('612345678', 'DE')).toBe('612345678');
  });
  it('returns null for blank', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(' + ')).toBeNull();
  });
});

describe('normalizePostCode', () => {
  it('drops the dash and spaces Meta forbids in zp', () => {
    expect(normalizePostCode(' 30-001 ')).toBe('30001');
    expect(normalizePostCode('SW1A 1AA')).toBe('sw1a1aa');
  });
  it('returns null for blank', () => {
    expect(normalizePostCode(' - ')).toBeNull();
  });
});

describe('normalizeCity', () => {
  it('lowercases and drops spaces and punctuation, keeping UTF-8 letters', () => {
    expect(normalizeCity(' Bielsko-Biała ')).toBe('bielskobiała');
    expect(normalizeCity('Santa Cruz de Tenerife')).toBe('santacruzdetenerife');
  });
  it('returns null for blank', () => {
    expect(normalizeCity(' . ')).toBeNull();
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
