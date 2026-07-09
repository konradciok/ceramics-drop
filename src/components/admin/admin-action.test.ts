import { describe, it, expect } from 'vitest';
import { runAdminAction } from './admin-action';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('runAdminAction', () => {
  it('returns the API message on success', async () => {
    const fetchImpl = (async () => jsonResponse(200, { message: 'Zwrócono.' })) as unknown as typeof fetch;
    expect(await runAdminAction('/api/admin/refund', { body: { orderId: 'x' }, fetchImpl })).toEqual({
      ok: true,
      text: 'Zwrócono.',
    });
  });

  it('falls back to successText then a default when no message', async () => {
    const fetchImpl = (async () => jsonResponse(200, {})) as unknown as typeof fetch;
    expect((await runAdminAction('/p', { successText: 'OK!', fetchImpl })).text).toBe('OK!');
    expect((await runAdminAction('/p', { fetchImpl })).text).toBe('Gotowe.');
  });

  it('surfaces the API error reason on a non-2xx', async () => {
    const fetchImpl = (async () => jsonResponse(409, { error: 'order_conflict' })) as unknown as typeof fetch;
    expect(await runAdminAction('/p', { fetchImpl })).toEqual({ ok: false, text: 'order_conflict' });
  });

  it('falls back to HTTP <status> when the error body has no reason', async () => {
    const fetchImpl = (async () => jsonResponse(500, {})) as unknown as typeof fetch;
    expect((await runAdminAction('/p', { fetchImpl })).text).toBe('HTTP 500');
  });

  it('maps a network throw to an error outcome', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await runAdminAction('/p', { fetchImpl })).toEqual({ ok: false, text: 'offline' });
  });
});
