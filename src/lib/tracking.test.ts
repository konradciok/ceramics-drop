import { describe, it, expect } from 'vitest';
import { httpsUrlOrNull, inpostTrackingUrl } from './tracking';

describe('httpsUrlOrNull', () => {
  it('accepts absolute https URLs', () => {
    expect(httpsUrlOrNull('https://track.dhl.com/x?id=123')).toBe('https://track.dhl.com/x?id=123');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(httpsUrlOrNull('  https://track.dhl.com/x  ')).toBe('https://track.dhl.com/x');
  });

  it.each([
    ['http (not https)', 'http://track.dhl.com/x'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['javascript scheme with slashes', 'javascript://x%0aalert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['protocol-relative', '//evil.example/x'],
    ['relative path', '/track/123'],
    ['bare word', 'not-a-url'],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('rejects %s', (_label, value) => {
    expect(httpsUrlOrNull(value)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['object', { url: 'https://x.test' }],
  ])('rejects non-string input (%s)', (_label, value) => {
    expect(httpsUrlOrNull(value)).toBeNull();
  });
});

describe('inpostTrackingUrl', () => {
  it('builds the public InPost tracking page URL', () => {
    expect(inpostTrackingUrl('520000000000000000000000')).toBe(
      'https://inpost.pl/sledzenie-przesylek?number=520000000000000000000000',
    );
  });

  it('URL-encodes the tracking number', () => {
    expect(inpostTrackingUrl('a b&c')).toBe(
      'https://inpost.pl/sledzenie-przesylek?number=a%20b%26c',
    );
  });
});
