import { describe, expect, it, vi, beforeEach } from 'vitest';
import { collectionsRestorePostRoute } from './collections-restore';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import * as mapping from '../collections-mapping';

vi.mock('../idempotency');
vi.mock('../collections-mapping');

function req(body: unknown, idempotencyKey: string | null = 'key-1') {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request('https://x.test/v1/collections/col_1/restore', { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

describe('collectionsRestorePostRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await collectionsRestorePostRoute.handler(
      req({ expectedRevision: 2, sourceRevision: 1 }, null),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(vi.fn()),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('rejects a literal null request body with 422 instead of throwing', async () => {
    const res = await collectionsRestorePostRoute.handler(req(null), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a body missing expectedRevision', async () => {
    const res = await collectionsRestorePostRoute.handler(req({ sourceRevision: 1 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    const parsedBody = await res.json();
    expect(parsedBody.code).toBe('VALIDATION_FAILED');
    expect(parsedBody.fieldErrors).toEqual({ expectedRevision: 'required' });
  });

  it('rejects a body missing sourceRevision', async () => {
    const res = await collectionsRestorePostRoute.handler(req({ expectedRevision: 2 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    const parsedBody = await res.json();
    expect(parsedBody.code).toBe('VALIDATION_FAILED');
    expect(parsedBody.fieldErrors).toEqual({ sourceRevision: 'required' });
  });

  it('rejects a fractional expectedRevision', async () => {
    const res = await collectionsRestorePostRoute.handler(
      req({ expectedRevision: 2.5, sourceRevision: 1 }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(vi.fn()),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).fieldErrors).toEqual({ expectedRevision: 'required' });
  });

  it('rejects a fractional sourceRevision', async () => {
    const res = await collectionsRestorePostRoute.handler(
      req({ expectedRevision: 2, sourceRevision: 1.5 }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(vi.fn()),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).fieldErrors).toEqual({ sourceRevision: 'required' });
  });

  it('idempotency replay: same key + same body returns the stored response and never calls the RPC', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 200, body: { id: 'col_1', revision: 3 } });
    const rpc = vi.fn();
    const res = await collectionsRestorePostRoute.handler(
      req({ expectedRevision: 2, sourceRevision: 1 }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(rpc),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'col_1', revision: 3 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns 409 when the key is already in flight', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'in_progress' });
    const res = await collectionsRestorePostRoute.handler(
      req({ expectedRevision: 2, sourceRevision: 1 }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(vi.fn()),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });

  it('returns 422 IDEMPOTENCY_KEY_REUSE when the same key is replayed with a different body', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'key_reuse' });
    const res = await collectionsRestorePostRoute.handler(
      req({ expectedRevision: 3, sourceRevision: 1 }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(vi.fn()),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('restores successfully at expectedRevision + 1, re-fetches via loadCollectionResponse with publishedRevision unchanged, and completes the idempotency key', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    // Collection was previously published at revision 1 (from an older draft)
    // and currently sits at draft revision 2 (expectedRevision). Restoring
    // source revision 1 must produce a NEW revision 3 — never touching
    // publishedRevision, which stays 1 (Global Constraint 19).
    const restored = {
      id: 'col_1',
      kind: 'collections',
      name: 'Spokojne formy',
      revision: 3,
      publishedRevision: 1,
      fields: [],
    };
    vi.mocked(mapping.loadCollectionResponse).mockResolvedValue(restored as never);

    const expectedRevision = 2;
    const sourceRevision = 1;
    const res = await collectionsRestorePostRoute.handler(
      req({ expectedRevision, sourceRevision }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(rpc),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(restored);
    expect(body.revision).toBe(expectedRevision + 1);
    expect(body.publishedRevision).toBe(1);

    expect(rpc).toHaveBeenCalledWith('restore_collection_draft', {
      p_collection_id: 'col_1',
      p_expected_revision: expectedRevision,
      p_source_revision: sourceRevision,
      p_actor_email: 'anna@studio.pl',
    });
    // Re-fetch happens after the RPC succeeds, not before.
    expect(mapping.loadCollectionResponse).toHaveBeenCalledWith(expect.anything(), 'col_1');
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalledWith(
      expect.anything(),
      'collections:restore',
      'key-1',
      'lease-1',
      200,
      restored,
    );
    expect(idempotency.releaseIdempotencyKey).not.toHaveBeenCalled();
  });

  it('maps collection_not_found to 404 and releases the idempotency key', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'collection_not_found' } });
    const res = await collectionsRestorePostRoute.handler(
      req({ expectedRevision: 1, sourceRevision: 1 }),
      {} as CloudflareEnv,
      { id: 'col_missing' },
      ctxWith(rpc),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('maps revision_conflict to 409 with currentRevision parsed from the detail string', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=7' } });
    const res = await collectionsRestorePostRoute.handler(
      req({ expectedRevision: 3, sourceRevision: 1 }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(rpc),
    );
    expect(res.status).toBe(409);
    const parsedBody = await res.json();
    expect(parsedBody.code).toBe('REVISION_CONFLICT');
    expect(parsedBody.currentRevision).toBe(7);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('maps source_revision_not_found to 404 NOT_FOUND and releases the idempotency key', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'source_revision_not_found' } });
    const res = await collectionsRestorePostRoute.handler(
      req({ expectedRevision: 2, sourceRevision: 99 }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(rpc),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('propagates the original restore error even when releasing the idempotency key also fails', async () => {
    const originalError = new Error('boom_original');
    const rpc = vi.fn().mockResolvedValue({ error: originalError });
    // First release call (inside the `if (error)` branch) succeeds; the
    // second (in the outer catch, guarding the rethrow) fails — the original
    // error must still win rather than being masked by the release failure.
    vi.mocked(idempotency.releaseIdempotencyKey)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('release_failed'));
    await expect(
      collectionsRestorePostRoute.handler(
        req({ expectedRevision: 1, sourceRevision: 1 }),
        {} as CloudflareEnv,
        { id: 'col_1' },
        ctxWith(rpc),
      ),
    ).rejects.toThrow('boom_original');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalledTimes(2);
  });
});
