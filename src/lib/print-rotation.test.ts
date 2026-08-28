import { describe, it, expect } from 'vitest';
import { dateKey, pickDaily } from './print-rotation';

type Item = { id: string };

const pool: Item[] = Array.from({ length: 41 }, (_, i) => ({
  id: `fap${String(i + 1).padStart(3, '0')}`,
}));

describe('dateKey', () => {
  it('formats the UTC calendar day as YYYY-MM-DD with zero padding', () => {
    expect(dateKey(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01-05');
    expect(dateKey(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe('2026-12-31');
  });

  it('uses UTC, not local time', () => {
    // 23:30 UTC is already the next local day in UTC+2 — key must stay on the UTC day.
    expect(dateKey(new Date(Date.UTC(2026, 7, 28, 23, 30)))).toBe('2026-08-28');
  });
});

describe('pickDaily', () => {
  it('is deterministic: same key + same pool -> identical result on repeated calls', () => {
    const a = pickDaily(pool, { count: 5, dateKey: '2026-08-28' });
    const b = pickDaily(pool, { count: 5, dateKey: '2026-08-28' });
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
  });

  it('rotates across days: at least one of three consecutive dates differs', () => {
    const sets = ['2026-08-28', '2026-08-29', '2026-09-01'].map((key) =>
      pickDaily(pool, { count: 5, dateKey: key }).map((d) => d.id).join(','),
    );
    expect(new Set(sets).size).toBeGreaterThan(1);
  });

  it('honours exclusions and returns no duplicates', () => {
    const exclude = new Set(['fap001', 'fap002', 'fap011', 'fap015']);
    const picked = pickDaily(pool, { count: 5, dateKey: '2026-08-28', exclude });
    expect(picked).toHaveLength(5);
    const ids = picked.map((d) => d.id);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) {
      expect(exclude.has(id)).toBe(false);
      expect(pool.some((p) => p.id === id)).toBe(true);
    }
  });

  it('returns all remaining items when the pool is smaller than count after exclusion', () => {
    const tiny = pool.slice(0, 6);
    const exclude = new Set(['fap001', 'fap002', 'fap003']);
    const picked = pickDaily(tiny, { count: 5, dateKey: '2026-08-28', exclude });
    expect(picked.map((d) => d.id).sort()).toEqual(['fap004', 'fap005', 'fap006']);
  });

  it('returns [] for an empty pool', () => {
    expect(pickDaily([], { count: 5, dateKey: '2026-08-28' })).toEqual([]);
  });

  it('does not mutate the input pool', () => {
    const copy = pool.map((d) => ({ ...d }));
    pickDaily(pool, { count: 5, dateKey: '2026-08-28' });
    expect(pool).toEqual(copy);
  });
});
