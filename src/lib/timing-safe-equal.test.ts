import { describe, it, expect } from 'vitest';
import { timingSafeEqual } from './timing-safe-equal';

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('tok_good', 'tok_good')).toBe(true);
  });

  it('returns false for same-length different strings', () => {
    expect(timingSafeEqual('tok_good', 'tok_badd')).toBe(false);
  });

  it('returns false for different-length strings', () => {
    expect(timingSafeEqual('short', 'longer-string')).toBe(false);
  });

  it('returns true for both empty', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('returns false for one empty, one non-empty', () => {
    expect(timingSafeEqual('', 'x')).toBe(false);
    expect(timingSafeEqual('x', '')).toBe(false);
  });
});
