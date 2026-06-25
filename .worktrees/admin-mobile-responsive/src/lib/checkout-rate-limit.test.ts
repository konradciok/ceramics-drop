import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHECKOUT_RATE_LIMIT,
  createCheckoutRateLimiter,
} from './checkout-rate-limit';

describe('createCheckoutRateLimiter', () => {
  it('blocks the request after the per-minute budget is exhausted', () => {
    const limiter = createCheckoutRateLimiter();
    const now = 10_000;

    for (let i = 0; i < DEFAULT_CHECKOUT_RATE_LIMIT.maxRequests; i += 1) {
      expect(limiter.allow('203.0.113.40', now + i).ok).toBe(true);
    }

    const blocked = limiter.allow('203.0.113.40', now + DEFAULT_CHECKOUT_RATE_LIMIT.maxRequests);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets after the one-minute window elapses', () => {
    const limiter = createCheckoutRateLimiter();
    const now = 20_000;

    for (let i = 0; i < DEFAULT_CHECKOUT_RATE_LIMIT.maxRequests; i += 1) {
      expect(limiter.allow('203.0.113.41', now + i).ok).toBe(true);
    }

    expect(
      limiter.allow(
        '203.0.113.41',
        now + DEFAULT_CHECKOUT_RATE_LIMIT.windowMs + 1,
      ).ok,
    ).toBe(true);
  });

  it('tracks IPs independently', () => {
    const limiter = createCheckoutRateLimiter({ maxRequests: 2 });
    expect(limiter.allow('203.0.113.1', 1).ok).toBe(true);
    expect(limiter.allow('203.0.113.2', 1).ok).toBe(true);
    expect(limiter.allow('203.0.113.1', 2).ok).toBe(true);
    expect(limiter.allow('203.0.113.1', 3).ok).toBe(false); // .1 exhausted
    expect(limiter.allow('203.0.113.2', 3).ok).toBe(true); // .2 unaffected
  });

  it('trims surrounding whitespace so it maps to one bucket', () => {
    const limiter = createCheckoutRateLimiter({ maxRequests: 1 });
    expect(limiter.allow(' 203.0.113.9 ', 1).ok).toBe(true);
    expect(limiter.allow('203.0.113.9', 2).ok).toBe(false);
  });

  it('fails open for null / empty / whitespace-only IPs', () => {
    const limiter = createCheckoutRateLimiter({ maxRequests: 1 });
    expect(limiter.allow(null, 1).ok).toBe(true);
    expect(limiter.allow('', 1).ok).toBe(true);
    expect(limiter.allow('   ', 1).ok).toBe(true);
  });

  it('bounds memory to maxEntries', () => {
    const store = new Map();
    const limiter = createCheckoutRateLimiter({ maxEntries: 2, store });
    limiter.allow('a', 1);
    limiter.allow('b', 1);
    limiter.allow('c', 1); // exceeds the cap → eviction keeps the store bounded
    expect(store.size).toBeLessThanOrEqual(2);
  });
});
