import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { readWithFallback, supabaseTimeout } from './supabase-timeout';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('readWithFallback', () => {
  it('returns the resolved value on success without touching Sentry', async () => {
    await expect(readWithFallback('ok', async () => 'value', 'fallback')).resolves.toBe('value');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('returns the fallback and reports to Sentry when fn rejects', async () => {
    const err = new Error('boom');
    await expect(readWithFallback('failing', async () => {
      throw err;
    }, 'fallback', { id: 'k01' })).resolves.toBe('fallback');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: { supabaseTimeoutLabel: 'failing' }, extra: { id: 'k01' } }),
    );
  });
});

describe('supabaseTimeout', () => {
  it('produces an AbortSignal that fires within the given bound', async () => {
    // Validates the timeout *mechanism* directly with a real, short timer —
    // a genuinely-never-resolving promise raced against it must still settle
    // quickly. Real timers (not vi.useFakeTimers) because AbortSignal.timeout
    // is a platform primitive not reliably intercepted by fake timers.
    const signal = supabaseTimeout(20);
    const hung = new Promise<never>(() => {});
    const aborted = new Promise<'aborted'>((resolve) => {
      signal.addEventListener('abort', () => resolve('aborted'));
    });

    const result = await Promise.race([hung, aborted]);
    expect(result).toBe('aborted');
  });
});
