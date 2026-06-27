import { describe, it, expect } from 'vitest';
import { ProdigiError } from './client';

describe('ProdigiError', () => {
  it('marks network failures as retryable', () => {
    const err = new ProdigiError('Network error', null, true);
    expect(err.retryable).toBe(true);
  });
  it('marks 5xx as retryable', () => {
    const err = new ProdigiError('Server error', 500, true);
    expect(err.retryable).toBe(true);
  });
  it('marks 4xx (except 429) as non-retryable', () => {
    const err = new ProdigiError('Bad request', 400, false);
    expect(err.retryable).toBe(false);
  });
  it('is an Error subclass', () => {
    expect(new ProdigiError('x', 400, false)).toBeInstanceOf(Error);
  });
});
