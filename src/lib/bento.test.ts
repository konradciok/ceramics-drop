import { describe, it, expect } from 'vitest';
import { featureKind } from './bento';

describe('featureKind', () => {
  it('heroes the first tile', () => {
    expect(featureKind(0)).toBe('lead');
  });
  it('widens every 7th tile after the lead', () => {
    expect(featureKind(7)).toBe('wide');
    expect(featureKind(14)).toBe('wide');
  });
  it('leaves the rest uniform', () => {
    for (const i of [1, 2, 3, 4, 5, 6, 8]) expect(featureKind(i)).toBeUndefined();
  });
});
