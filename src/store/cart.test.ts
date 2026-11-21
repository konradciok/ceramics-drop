import { describe, it, expect } from 'vitest';
import { isRetiredCartToken } from './cart';

describe('isRetiredCartToken', () => {
  it('flags print tokens (prints moved to their own shop) and non-strings', () => {
    expect(isRetiredCartToken('print:fap001:30x40:false:false:none')).toBe(true);
    expect(isRetiredCartToken(42)).toBe(true);
  });

  it('keeps ceramic pieces and gift cards', () => {
    expect(isRetiredCartToken('k01')).toBe(false);
    expect(isRetiredCartToken('giftcard:gc-100')).toBe(false);
  });
});
