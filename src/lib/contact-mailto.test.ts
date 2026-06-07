import { describe, expect, it } from 'vitest';
import { buildContactMailto } from './contact-mailto';

const base = {
  to: 'hej@ciok.art',
  subject: '[Anna Ciok Ceramics] Studio pickup',
  signature: '\n\n— Ania (ania@example.com)',
  truncatedNote: 'Message truncated — please paste the rest before sending',
};

describe('buildContactMailto', () => {
  it('keeps short messages intact, without the truncation note', () => {
    const url = buildContactMailto({ ...base, message: 'Hej! Czy mogę odebrać kubek osobiście?' });
    expect(url).toContain(encodeURIComponent('Czy mogę odebrać kubek osobiście?'));
    expect(url).toContain(encodeURIComponent(base.signature));
    expect(url).not.toContain(encodeURIComponent(base.truncatedNote));
  });

  it('caps long ASCII messages at the encoded URL budget and appends the note', () => {
    const url = buildContactMailto({ ...base, message: 'a'.repeat(5000) });
    expect(url.length).toBeLessThanOrEqual(1900);
    expect(url).toContain(encodeURIComponent(base.truncatedNote));
    expect(url).toContain(encodeURIComponent(base.signature));
  });

  it('measures the encoded length, not raw characters (diacritics expand 6x)', () => {
    // 1500 raw chars — would pass a raw-length check but encodes to ~9000 chars.
    const url = buildContactMailto({ ...base, message: 'żółć'.repeat(375) });
    expect(url.length).toBeLessThanOrEqual(1900);
    expect(url).toContain(encodeURIComponent(base.truncatedNote));
  });

  it('never splits a surrogate pair at the cut point', () => {
    // encodeURIComponent throws URIError on lone surrogates.
    const url = buildContactMailto({ ...base, message: '🏺'.repeat(2000) });
    expect(url.length).toBeLessThanOrEqual(1900);
    expect(url).not.toContain('%ED%A0'); // CESU-8 style lone-high-surrogate bytes
  });

  it('falls back to a bare address when even an empty body cannot fit', () => {
    const url = buildContactMailto({
      ...base,
      signature: `\n\n— ${'x'.repeat(4000)}`,
      message: 'hello',
    });
    expect(url).toBe(`mailto:${base.to}?subject=${encodeURIComponent(base.subject)}`);
  });

  it('respects a custom budget', () => {
    const url = buildContactMailto({ ...base, message: 'a'.repeat(500) }, 300);
    expect(url.length).toBeLessThanOrEqual(300);
    expect(url).toContain(encodeURIComponent(base.truncatedNote));
  });
});
