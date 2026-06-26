import { describe, it, expect } from 'vitest';
import { isUnderfulfilled } from './fulfillment';

describe('isUnderfulfilled', () => {
  it('returns false when counts match (ceramic order)', () => {
    expect(isUnderfulfilled(2, 2)).toBe(false);
  });
  it('returns false when 0 = 0 (print-only order)', () => {
    expect(isUnderfulfilled(0, 0)).toBe(false);
  });
  it('returns true when under-fulfilled', () => {
    expect(isUnderfulfilled(1, 2)).toBe(true);
  });
});
