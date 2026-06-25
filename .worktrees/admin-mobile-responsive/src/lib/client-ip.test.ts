import { describe, expect, it } from 'vitest';
import { getClientIp } from './client-ip';

const reqWith = (headers: Record<string, string>) => ({
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
});

describe('getClientIp', () => {
  it('prefers cf-connecting-ip over x-forwarded-for', () => {
    const ip = getClientIp(reqWith({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }), {
      trustForwarded: true,
    });
    expect(ip).toBe('1.1.1.1');
  });

  it('ignores x-forwarded-for unless explicitly trusted', () => {
    expect(getClientIp(reqWith({ 'x-forwarded-for': '2.2.2.2' }))).toBe(null);
    expect(getClientIp(reqWith({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3' }), { trustForwarded: true })).toBe('2.2.2.2');
  });

  it('returns null when no usable header is present', () => {
    expect(getClientIp(reqWith({}), { trustForwarded: true })).toBe(null);
  });
});
