import { describe, it, expect } from 'vitest';
import { datetimeLocalToIso, isoToDatetimeLocal, majorToMinor } from './promo-form';

describe('datetimeLocalToIso', () => {
  it('treats empty / whitespace input as null (open-ended window)', () => {
    expect(datetimeLocalToIso('')).toBeNull();
    expect(datetimeLocalToIso('   ')).toBeNull();
  });

  it('converts a boundary datetime-local value to a Z-suffixed ISO string that round-trips to the same instant', () => {
    const iso = datetimeLocalToIso('2026-12-31T23:59');
    expect(iso).toMatch(/Z$/); // zod z.string().datetime() requires the offset
    // Round-trip: the ISO parses back to the operator's intended local instant.
    expect(isoToDatetimeLocal(iso)).toBe('2026-12-31T23:59');
    expect(new Date(iso as string).getTime()).toBe(new Date('2026-12-31T23:59').getTime());
  });

  it('returns null for garbage input', () => {
    expect(datetimeLocalToIso('not-a-date')).toBeNull();
  });
});

describe('isoToDatetimeLocal', () => {
  it('maps null to the empty input value', () => {
    expect(isoToDatetimeLocal(null)).toBe('');
  });
});

describe('majorToMinor', () => {
  it('converts operator-entered major units to integer minor units', () => {
    expect(majorToMinor('50')).toBe(5000);
    expect(majorToMinor('12.5')).toBe(1250);
  });

  it('empty → null; garbage propagates NaN for the server-side reject', () => {
    expect(majorToMinor('')).toBeNull();
    expect(majorToMinor('abc')).toBeNaN();
  });
});
