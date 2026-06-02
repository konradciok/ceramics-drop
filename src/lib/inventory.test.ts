import { describe, it, expect } from 'vitest';
import { isAvailable } from './inventory';

describe('isAvailable', () => {
  const now = new Date('2026-06-02T12:00:00Z');
  it('available when status available', () => {
    expect(isAvailable({ status: 'available', reserved_until: null }, now)).toBe(true);
  });
  it('unavailable when sold', () => {
    expect(isAvailable({ status: 'sold', reserved_until: null }, now)).toBe(false);
  });
  it('unavailable while reservation is live', () => {
    expect(isAvailable({ status: 'reserved', reserved_until: '2026-06-02T12:10:00Z' }, now)).toBe(false);
  });
  it('available again once the hold expires', () => {
    expect(isAvailable({ status: 'reserved', reserved_until: '2026-06-02T11:50:00Z' }, now)).toBe(true);
  });
});
