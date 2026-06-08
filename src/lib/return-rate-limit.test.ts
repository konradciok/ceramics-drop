import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETURN_RATE_LIMIT,
  createReturnRateLimiter,
} from './return-rate-limit';

describe('createReturnRateLimiter', () => {
  it('blocks the fourth request from the same IP inside the window', () => {
    const limiter = createReturnRateLimiter();
    const now = 1_000;

    expect(limiter.allow('203.0.113.7', now).ok).toBe(true);
    expect(limiter.allow('203.0.113.7', now + 1).ok).toBe(true);
    expect(limiter.allow('203.0.113.7', now + 2).ok).toBe(true);

    const blocked = limiter.allow('203.0.113.7', now + 3);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets the bucket after the window expires', () => {
    const limiter = createReturnRateLimiter();
    const now = 5_000;

    expect(limiter.allow('203.0.113.8', now).ok).toBe(true);
    expect(limiter.allow('203.0.113.8', now + 1).ok).toBe(true);
    expect(limiter.allow('203.0.113.8', now + 2).ok).toBe(true);
    expect(limiter.allow('203.0.113.8', now + DEFAULT_RETURN_RATE_LIMIT.windowMs + 1).ok).toBe(true);
  });

  it('allows requests when the client IP is unavailable', () => {
    const limiter = createReturnRateLimiter();

    expect(limiter.allow(null, 1_000).ok).toBe(true);
    expect(limiter.allow('', 1_001).ok).toBe(true);
  });

  it('bounds memory to maxEntries', () => {
    const store = new Map();
    const limiter = createReturnRateLimiter({ maxEntries: 2, store });

    limiter.allow('a', 1);
    limiter.allow('b', 1);
    limiter.allow('c', 1); // exceeds the cap → eviction keeps the store bounded
    expect(store.size).toBeLessThanOrEqual(2);
  });
});
