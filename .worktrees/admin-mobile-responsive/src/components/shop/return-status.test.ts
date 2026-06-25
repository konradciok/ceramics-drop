import { describe, it, expect } from 'vitest';
import { returnStatusMessageKey } from './return-status';

describe('returnStatusMessageKey', () => {
  it('maps API statuses to message keys', () => {
    expect(returnStatusMessageKey(200)).toBe('success');
    expect(returnStatusMessageKey(404)).toBe('ineligible');
    expect(returnStatusMessageKey(429)).toBe('rateLimited');
    expect(returnStatusMessageKey(503)).toBe('unavailable');
    expect(returnStatusMessageKey(400)).toBe('error');
    expect(returnStatusMessageKey(500)).toBe('error');
  });
});
