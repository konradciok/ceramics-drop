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
});
