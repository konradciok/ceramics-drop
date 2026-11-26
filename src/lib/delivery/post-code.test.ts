import { describe, it, expect } from 'vitest';
import { PL_POST_CODE_RE, formatPlPostCode, normalizePlPostCode } from './post-code';

describe('formatPlPostCode', () => {
  it.each([
    ['', ''],
    ['3', '3'],
    ['31', '31'],
    ['31-', '31'],
    ['310', '31-0'],
    ['31019', '31-019'],
    ['31-019', '31-019'],
    ['31 019', '31-019'],
    ['310199', '31-019'],
    ['ab31c019', '31-019'],
  ])('formats %j as %j', (raw, expected) => {
    expect(formatPlPostCode(raw)).toBe(expected);
  });

  it('produces the canonical form once five digits are typed', () => {
    expect(PL_POST_CODE_RE.test(formatPlPostCode('00950'))).toBe(true);
  });
});

describe('normalizePlPostCode', () => {
  it.each([
    ['31-019', '31-019'],
    ['31019', '31-019'],
    [' 31 019 ', '31-019'],
  ])('accepts %j as %j', (raw, expected) => {
    expect(normalizePlPostCode(raw)).toBe(expected);
  });

  it.each(['', '3101', '310199', '31--019', '31-0a9', '28013-1', 'SW1A 1AA'])('rejects %j', (raw) => {
    expect(normalizePlPostCode(raw)).toBeNull();
  });
});
