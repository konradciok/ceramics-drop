import { createReturnRateLimiter } from '@/lib/return-rate-limit';

export const DEFAULT_AUTH_RATE_LIMIT = {
  maxRequests: 10,
  windowMs: 10 * 60 * 1000,
} as const;

/**
 * Fixed-window per-IP limiter for `/api/auth/login` — same engine and caveats
 * as the `/api/returns` limiter (per-isolate, best-effort first layer; the
 * authoritative defense is the edge WAF rule). Each allowed request only costs
 * a redirect to the provider, so the window is generous.
 */
export function createAuthRateLimiter() {
  return createReturnRateLimiter({ ...DEFAULT_AUTH_RATE_LIMIT });
}
