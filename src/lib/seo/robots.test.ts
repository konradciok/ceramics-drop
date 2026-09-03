import { describe, it, expect } from 'vitest';
import { previewRobots } from './robots';

describe('previewRobots', () => {
  it('is indexable when the preview param is absent', () => {
    expect(previewRobots(undefined)).toBeUndefined();
  });

  it('noindexes an empty preview value (the presence-vs-truthiness regression)', () => {
    expect(previewRobots('')).toEqual({ index: false, follow: false });
  });

  it('noindexes a non-empty (even invalid) preview token', () => {
    expect(previewRobots('garbage-token')).toEqual({ index: false, follow: false });
  });

  it('noindexes a repeated preview query key delivered as an array', () => {
    expect(previewRobots(['a', 'b'])).toEqual({ index: false, follow: false });
  });
});
