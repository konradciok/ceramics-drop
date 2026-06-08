import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETURN_RATE_LIMIT,
  createReturnRateLimiter,
} from './return-rate-limit';

describe('createReturnRateLimiter', () => {
  it('blocks the fourth request from the same IP inside the window', () => {
    const limiter = createReturnRateLimiter();
    const now = 1_000;

    expect(limiter.allow('203.0.113.7', now)).toBe(true);
    expect(limiter.allow('203.0.113.7', now + 1)).toBe(true);
    expect(limiter.allow('203.0.113.7', now + 2)).toBe(true);
    expect(limiter.allow('203.0.113.7', now + 3)).toBe(false);
  });

  it('resets the bucket after the window expires', () => {
    const limiter = createReturnRateLimiter();
    const now = 5_000;

    expect(limiter.allow('203.0.113.8', now)).toBe(true);
    expect(limiter.allow('203.0.113.8', now + 1)).toBe(true);
    expect(limiter.allow('203.0.113.8', now + 2)).toBe(true);
    expect(limiter.allow('203.0.113.8', now + DEFAULT_RETURN_RATE_LIMIT.windowMs + 1)).toBe(true);
  });

  it('allows requests when the client IP is unavailable', () => {
    const limiter = createReturnRateLimiter();

    expect(limiter.allow(null, 1_000)).toBe(true);
    expect(limiter.allow('', 1_001)).toBe(true);
  });
});
