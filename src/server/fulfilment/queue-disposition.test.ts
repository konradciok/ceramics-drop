import { describe, it, expect } from 'vitest';
import { decideMessageDisposition } from './queue-disposition';
import { ProdigiError } from '../prodigi/client';

describe('decideMessageDisposition', () => {
  it('retries a plain Error (transient default)', () =>
    expect(decideMessageDisposition(new Error('boom'))).toBe('retry'));

  it('retries when retryable is true', () =>
    expect(decideMessageDisposition({ retryable: true })).toBe('retry'));

  it('acks when retryable is false (terminal failure)', () =>
    expect(decideMessageDisposition({ retryable: false })).toBe('ack'));

  it('retries when retryable is absent (unknown shape defaults to retry)', () =>
    expect(decideMessageDisposition({})).toBe('retry'));

  it('retries on null (?. yields undefined, not === false)', () =>
    expect(decideMessageDisposition(null)).toBe('retry'));

  it('retries on undefined', () =>
    expect(decideMessageDisposition(undefined)).toBe('retry'));

  it('acks a real ProdigiError marked retryable: false (ties contract to actual shape)', () =>
    expect(decideMessageDisposition(new ProdigiError('Prodigi 400: bad sku', 400, false))).toBe('ack'));
});
