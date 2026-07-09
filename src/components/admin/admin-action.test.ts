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

  it('maps a known error code to a friendly PL label', async () => {
    const fetchImpl = (async () => jsonResponse(409, { error: 'order_conflict' })) as unknown as typeof fetch;
    const out = await runAdminAction('/p', { fetchImpl });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/odśwież stronę/);
  });

  it('passes an unknown error code through verbatim', async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: 'weird_reason' })) as unknown as typeof fetch;
    expect(await runAdminAction('/p', { fetchImpl })).toEqual({ ok: false, text: 'weird_reason' });
  });

  it('honours a per-call errorMap override', async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: 'boom' })) as unknown as typeof fetch;
    expect((await runAdminAction('/p', { fetchImpl, errorMap: { boom: 'Bum!' } })).text).toBe('Bum!');
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
