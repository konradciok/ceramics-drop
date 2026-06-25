import { describe, it, expect } from 'vitest';
import { useFilter } from './filter';

describe('useFilter store', () => {
  it('defaults to "all"', () => {
    expect(useFilter.getState().status).toBe('all');
  });

  it('setStatus updates the active view', () => {
    useFilter.getState().setStatus('available');
    expect(useFilter.getState().status).toBe('available');
  });
});
