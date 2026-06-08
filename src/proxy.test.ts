import { describe, it, expect } from 'vitest';
import proxy from './proxy';
import { NextRequest } from 'next/server';

describe('proxy security headers', () => {
  it('sets HSTS and the hardening headers on HTML responses', () => {
    const res = proxy(new NextRequest('https://anna-ciok.studio/pl'));
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Content-Security-Policy-Report-Only')).toContain("default-src 'self'");
  });
});
