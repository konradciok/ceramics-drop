import { describe, it, expect, beforeEach } from 'vitest';
import { useFilter } from './filter';

describe('useFilter store', () => {
  beforeEach(() => {
    useFilter.setState({ status: 'all' });
  });

  it('defaults to "all"', () => {
    expect(useFilter.getState().status).toBe('all');
  });

  it('setStatus updates the active view', () => {
    useFilter.getState().setStatus('available');
    expect(useFilter.getState().status).toBe('available');
  });
});
