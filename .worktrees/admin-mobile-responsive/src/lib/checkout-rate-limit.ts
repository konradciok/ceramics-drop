export const DEFAULT_CHECKOUT_RATE_LIMIT = {
  maxRequests: 30,
  windowMs: 60 * 1000,
  maxEntries: 50_000,
} as const;

type Bucket = {
  count: number;
  resetAt: number;
};

export type RateLimitResult = { ok: boolean; retryAfterSeconds: number };

/**
 * Lightweight per-IP fixed-window limiter for checkout attempts.
 *
 * NOTE: the store is an in-memory Map, so on Cloudflare Workers it is per-isolate
 * (not coordinated across isolates / PoPs) and resets when an isolate recycles.
 * This is a best-effort backstop for `/api/checkout`; the stronger global control
 * is still the Cloudflare WAF rate-limit rule tracked in plan T15.
 */
export function createCheckoutRateLimiter(
  options: {
    maxRequests?: number;
    windowMs?: number;
    maxEntries?: number;
    store?: Map<string, Bucket>;
  } = {},
) {
  const maxRequests = options.maxRequests ?? DEFAULT_CHECKOUT_RATE_LIMIT.maxRequests;
  const windowMs = options.windowMs ?? DEFAULT_CHECKOUT_RATE_LIMIT.windowMs;
  const maxEntries = options.maxEntries ?? DEFAULT_CHECKOUT_RATE_LIMIT.maxEntries;
  const store = options.store ?? new Map<string, Bucket>();

  function makeRoom(now: number): void {
    if (store.size < maxEntries) return;
    for (const [key, bucket] of store) {
      if (bucket.resetAt <= now) store.delete(key);
    }
    while (store.size >= maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }

  return {
    allow(ip: string | null | undefined, now = Date.now()): RateLimitResult {
      const key = ip?.trim();
      if (!key) return { ok: true, retryAfterSeconds: 0 };

      const bucket = store.get(key);
      if (!bucket || bucket.resetAt <= now) {
        makeRoom(now);
        store.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true, retryAfterSeconds: 0 };
      }

      if (bucket.count >= maxRequests) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
      }

      bucket.count += 1;
      return { ok: true, retryAfterSeconds: 0 };
    },
  };
}
