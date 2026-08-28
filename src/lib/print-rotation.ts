/**
 * Deterministic daily rotation for the homepage hero-beat print tiles.
 * Pure and dependency-free so the pick is testable and identical across
 * V8 (build-time prerender) and workerd (per-request render): FNV-1a hash
 * of the date key seeds a mulberry32 PRNG driving a Fisher–Yates shuffle.
 */

/** UTC calendar day as 'YYYY-MM-DD' — the daily rotation seed. UTC (not
    server-local time) so every Cloudflare PoP agrees on "today". */
export function dateKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic date-seeded pick: filters `exclude`, shuffles a copy with a
 * seeded Fisher–Yates, returns the first `count` (fewer if the filtered pool
 * is smaller). Same key + same pool order → same result, so the outcome also
 * depends on the caller passing a stably-ordered pool (registry order).
 */
export function pickDaily<T extends { id: string }>(
  pool: readonly T[],
  opts: { count: number; dateKey: string; exclude?: ReadonlySet<string> },
): T[] {
  const candidates = pool.filter((item) => !opts.exclude?.has(item.id));
  const rand = mulberry32(fnv1a(opts.dateKey));
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, opts.count);
}
