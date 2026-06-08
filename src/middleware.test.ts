import { describe, it, expect } from 'vitest';
import middleware from './middleware';
import { NextRequest } from 'next/server';

describe('middleware security headers', () => {
  it('sets HSTS and the hardening headers on HTML responses', () => {
    const res = middleware(new NextRequest('https://anna-ciok.studio/pl'));
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Content-Security-Policy-Report-Only')).toContain("default-src 'self'");
  });
});
