import { afterEach, describe, expect, it, vi } from 'vitest';

// loadStripe is the only thing stripe-client touches; mock it so we can drive
// both the happy path and the in-app-browser "Failed to load Stripe.js" path.
const loadStripeMock = vi.fn();
vi.mock('@stripe/stripe-js', () => ({
  loadStripe: (...args: unknown[]) => loadStripeMock(...args),
}));

afterEach(() => {
  vi.resetModules(); // reset the module-level singleton between tests
  loadStripeMock.mockReset();
});

describe('getStripe', () => {
  it('memoises loadStripe into a single shared promise', async () => {
    loadStripeMock.mockResolvedValue({ id: 'stripe' });
    const { getStripe } = await import('./stripe-client');

    const first = getStripe();
    const second = getStripe();

    expect(first).toBe(second);
    expect(loadStripeMock).toHaveBeenCalledTimes(1);
  });

  it('does not surface an unhandledRejection when Stripe.js fails to load', async () => {
    // Reject lazily inside the mock so the rejected promise is created only when
    // getStripe() calls loadStripe — and getStripe attaches its guard catch
    // synchronously right after, leaving no window for a stray rejection.
    loadStripeMock.mockImplementation(() =>
      Promise.reject(new Error('Failed to load Stripe.js')),
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const { getStripe } = await import('./stripe-client');
      // Intentionally do NOT attach a handler — this mirrors CartView, where the
      // promise is created at module scope but only consumed once <Elements> mounts.
      getStripe();
      // Let the microtask + macrotask queues drain so Node can report any leak.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it('still rejects for consumers that await the promise', async () => {
    loadStripeMock.mockImplementation(() =>
      Promise.reject(new Error('Failed to load Stripe.js')),
    );
    const { getStripe } = await import('./stripe-client');

    await expect(getStripe()).rejects.toThrow('Failed to load Stripe.js');
  });
});
