import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStallRetryFetch } from './supabase-stall-retry';

const URL_ = 'https://proj.supabase.co/rest/v1/products?select=*&type=eq.ceramic';

/** A fetch that never answers until its signal aborts — models a stalled connection. */
function stalledFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('createStallRetryFetch', () => {
  it('passes non-GET requests straight through, even with a signal (writes are never replayed)', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const f = createStallRetryFetch(base, 10);
    const init = { method: 'POST', signal: AbortSignal.timeout(1000) };
    await f(URL_, init);
    expect(base).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledWith(URL_, init);
  });

  it('passes unbounded GETs (no caller signal) straight through', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const f = createStallRetryFetch(base, 10);
    await f(URL_, { method: 'GET' });
    expect(base).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledWith(URL_, { method: 'GET' });
  });

  it('returns the first response when headers arrive before the attempt timeout', async () => {
    const base = vi.fn(async () => new Response('first'));
    const f = createStallRetryFetch(base, 50);
    const res = await f(URL_, { method: 'GET', signal: AbortSignal.timeout(1000) });
    expect(await res.text()).toBe('first');
    expect(base).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('retries once on a fresh fetch when the first attempt stalls', async () => {
    const base = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(stalledFetch)
      .mockImplementationOnce(async () => new Response('second'));
    const f = createStallRetryFetch(base, 20);
    const caller = AbortSignal.timeout(1000);
    const res = await f(URL_, { method: 'GET', signal: caller });
    expect(await res.text()).toBe('second');
    expect(base).toHaveBeenCalledTimes(2);
    // The retry is bounded by the caller's own signal, not a new budget.
    expect(base.mock.calls[1][1]?.signal).toBe(caller);
    expect(console.warn).toHaveBeenCalledWith(
      '[supabase-stall-retry] attempt stalled; retrying once',
      { method: 'GET', path: '/rest/v1/products', attemptTimeoutMs: 20 },
    );
  });

  it('does not retry a second time — a stalled retry ends with the caller timeout', async () => {
    const base = vi.fn(stalledFetch);
    const f = createStallRetryFetch(base, 20);
    const caller = AbortSignal.timeout(80);
    await expect(f(URL_, { method: 'GET', signal: caller })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(base).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the caller signal aborts first, and surfaces the caller reason', async () => {
    const base = vi.fn(stalledFetch);
    const f = createStallRetryFetch(base, 1000);
    const caller = AbortSignal.timeout(20);
    await expect(f(URL_, { method: 'GET', signal: caller })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(base).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('rethrows non-stall failures without retrying', async () => {
    const boom = new TypeError('Network connection lost.');
    const base = vi.fn(async () => {
      throw boom;
    });
    const f = createStallRetryFetch(base, 1000);
    await expect(f(URL_, { method: 'GET', signal: AbortSignal.timeout(1000) })).rejects.toBe(boom);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('wires through a real supabase-js query: a stalled bounded select is retried and succeeds', async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const base = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(stalledFetch)
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify([{ id: 'k01' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
    const db = createClient('https://proj.supabase.co', 'service-role-key', {
      auth: { persistSession: false },
      global: { fetch: createStallRetryFetch(base, 20) },
    });
    const { data, error } = await db.from('products').select('id').abortSignal(AbortSignal.timeout(1000));
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 'k01' }]);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it('wires through a real supabase-js RPC: POST is never retried', async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const base = vi.fn(stalledFetch);
    const db = createClient('https://proj.supabase.co', 'service-role-key', {
      auth: { persistSession: false },
      global: { fetch: createStallRetryFetch(base, 20) },
    });
    const { error } = await db.rpc('reserve_pieces', { p_ids: ['k01'] }).abortSignal(AbortSignal.timeout(60));
    expect(error).not.toBeNull();
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('keeps the caller signal linked after headers arrive, so it can still cancel the body read', async () => {
    let attemptSignal: AbortSignal | undefined;
    const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      attemptSignal = init?.signal ?? undefined;
      return new Response('ok');
    });
    const caller = new AbortController();
    const f = createStallRetryFetch(base, 20);
    await f(URL_, { method: 'GET', signal: caller.signal });
    // Past the attempt timeout: the attempt timer must not abort a delivered response.
    await new Promise((r) => setTimeout(r, 40));
    expect(attemptSignal?.aborted).toBe(false);
    caller.abort(new Error('caller gave up'));
    expect(attemptSignal?.aborted).toBe(true);
  });
});
