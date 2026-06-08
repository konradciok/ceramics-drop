export const DEFAULT_RETURN_RATE_LIMIT = {
  maxRequests: 3,
  windowMs: 10 * 60 * 1000,
} as const;

type Bucket = {
  count: number;
  resetAt: number;
};

export function createReturnRateLimiter(
  options: {
    maxRequests?: number;
    windowMs?: number;
    store?: Map<string, Bucket>;
  } = {},
) {
  const maxRequests = options.maxRequests ?? DEFAULT_RETURN_RATE_LIMIT.maxRequests;
  const windowMs = options.windowMs ?? DEFAULT_RETURN_RATE_LIMIT.windowMs;
  const store = options.store ?? new Map<string, Bucket>();

  return {
    allow(ip: string | null | undefined, now = Date.now()): boolean {
      const key = ip?.trim();
      if (!key) return true;

      const bucket = store.get(key);
      if (!bucket || bucket.resetAt <= now) {
        store.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }

      if (bucket.count >= maxRequests) {
        return false;
      }

      bucket.count += 1;
      return true;
    },
  };
}
