import { describe, expect, it, vi } from 'vitest';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from './idempotency';

type Row = {
  status: 'processing' | 'done' | 'failed';
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  processing_started_at: string;
};

function fakeSupabase(initial?: Row) {
  let row: Row | undefined = initial;
  const client = {
    from: () => ({
      insert: (values: Partial<Row> & { operation: string; idempotency_key: string }) => ({
        select: () => ({
          maybeSingle: async () => {
            if (row) return { data: null, error: { code: '23505', message: 'duplicate' } };
            row = {
              status: 'processing',
              request_hash: values.request_hash as string,
              response_status: null,
              response_body: null,
              processing_started_at: values.processing_started_at as string,
            };
            return { data: { id: '1' }, error: null };
          },
        }),
      }),
      select: () => ({
        eq: () => ({
          eq: () => ({ single: async () => (row ? { data: row, error: null } : { data: null, error: new Error('not found') }) }),
        }),
      }),
      update: (patch: Partial<Row>) => ({
        eq: () => ({
          eq: () => ({
            eq: (_col: string, expected: string) => ({
              select: () => ({
                maybeSingle: async () => {
                  if (!row || row.processing_started_at !== expected) return { data: null, error: null };
                  row = { ...row, ...patch } as Row;
                  return { data: { id: '1' }, error: null };
                },
              }),
            }),
          }),
        }),
      }),
    }),
  };
  return { client: client as never, getRow: () => row };
}

describe('claimIdempotencyKey', () => {
  it('returns run on first claim', async () => {
    const { client } = fakeSupabase();
    const result = await claimIdempotencyKey(client, 'products:create', 'key-1', { a: 1 });
    expect(result).toEqual({ kind: 'run' });
  });

  it('replays the stored response for a done key with the same payload', async () => {
    const { client } = fakeSupabase({
      status: 'done',
      request_hash: await sha256({ a: 1 }),
      response_status: 200,
      response_body: { id: 'prd_x' },
      processing_started_at: new Date().toISOString(),
    });
    const result = await claimIdempotencyKey(client, 'products:create', 'key-1', { a: 1 });
    expect(result).toEqual({ kind: 'replay', status: 200, body: { id: 'prd_x' } });
  });

  it('reports key_reuse when the same key is sent with a different payload', async () => {
    const { client } = fakeSupabase({
      status: 'done',
      request_hash: await sha256({ a: 1 }),
      response_status: 200,
      response_body: { id: 'prd_x' },
      processing_started_at: new Date().toISOString(),
    });
    const result = await claimIdempotencyKey(client, 'products:create', 'key-1', { a: 2 });
    expect(result).toEqual({ kind: 'key_reuse' });
  });

  it('reports in_progress for a fresh in-flight lease', async () => {
    const { client } = fakeSupabase({
      status: 'processing',
      request_hash: await sha256({ a: 1 }),
      response_status: null,
      response_body: null,
      processing_started_at: new Date().toISOString(),
    });
    const result = await claimIdempotencyKey(client, 'products:create', 'key-1', { a: 1 });
    expect(result).toEqual({ kind: 'in_progress' });
  });

  it('reclaims a stale processing lease and returns run', async () => {
    const { client } = fakeSupabase({
      status: 'processing',
      request_hash: await sha256({ a: 1 }),
      response_status: null,
      response_body: null,
      processing_started_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const result = await claimIdempotencyKey(client, 'products:create', 'key-1', { a: 1 });
    expect(result).toEqual({ kind: 'run' });
  });
});

describe('completeIdempotencyKey / releaseIdempotencyKey', () => {
  it('does not throw when the update succeeds', async () => {
    const { client } = fakeSupabase({
      status: 'processing',
      request_hash: 'h',
      response_status: null,
      response_body: null,
      processing_started_at: new Date().toISOString(),
    });
    await expect(completeIdempotencyKey(client, 'products:create', 'key-1', 200, { ok: true })).resolves.toBeUndefined();
  });

  it('release does not throw when the update succeeds', async () => {
    const { client } = fakeSupabase({
      status: 'processing',
      request_hash: 'h',
      response_status: null,
      response_body: null,
      processing_started_at: new Date().toISOString(),
    });
    await expect(releaseIdempotencyKey(client, 'products:create', 'key-1')).resolves.toBeUndefined();
  });
});

async function sha256(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body ?? null));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
