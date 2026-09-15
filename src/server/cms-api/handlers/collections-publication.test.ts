import { describe, expect, it, vi, beforeEach } from 'vitest';
import { collectionsPublicationPostRoute } from './collections-publication';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import * as mapping from '../collections-mapping';

vi.mock('../idempotency');
vi.mock('../collections-mapping');

function req(body: unknown, idempotencyKey: string | null = 'key-1') {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request('https://x.test/v1/collections/col_1/publication', { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

describe('collectionsPublicationPostRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await collectionsPublicationPostRoute.handler(
      req({ expectedRevision: 1 }, null),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(vi.fn()),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('rejects a literal null request body with 422 instead of throwing', async () => {
    const res = await collectionsPublicationPostRoute.handler(req(null), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a body missing expectedRevision', async () => {
    const res = await collectionsPublicationPostRoute.handler(req({}), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a fractional expectedRevision', async () => {
    const res = await collectionsPublicationPostRoute.handler(req({ expectedRevision: 2.5 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors).toEqual({ expectedRevision: 'required' });
  });

  it('idempotency replay: same key + same body returns the stored response and never calls the RPC', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 200, body: { id: 'col_1', revision: 2 } });
    const rpc = vi.fn();
    const res = await collectionsPublicationPostRoute.handler(req({ expectedRevision: 2 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(rpc));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'col_1', revision: 2 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns 409 when the key is already in flight', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'in_progress' });
    const res = await collectionsPublicationPostRoute.handler(req({ expectedRevision: 2 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });

  it('returns 422 IDEMPOTENCY_KEY_REUSE when the same key is replayed with a different body', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'key_reuse' });
    const res = await collectionsPublicationPostRoute.handler(req({ expectedRevision: 3 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('publishes successfully, re-fetches via loadCollectionResponse, and completes the idempotency key with the re-fetched body', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const published = { id: 'col_1', kind: 'collections', name: 'Spokojne formy', revision: 2, publishedRevision: 2, fields: [] };
    vi.mocked(mapping.loadCollectionResponse).mockResolvedValue(published as never);

    const res = await collectionsPublicationPostRoute.handler(req({ expectedRevision: 2 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(rpc));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(published);
    expect(rpc).toHaveBeenCalledWith('publish_collection_revision', {
      p_collection_id: 'col_1',
      p_expected_revision: 2,
      p_actor_email: 'anna@studio.pl',
    });
    // Re-fetch happens after the RPC succeeds, not before.
    expect(mapping.loadCollectionResponse).toHaveBeenCalledWith(expect.anything(), 'col_1');
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalledWith(
      expect.anything(),
      'collections:publication',
      'key-1',
      'lease-1',
      200,
      published,
    );
    expect(idempotency.releaseIdempotencyKey).not.toHaveBeenCalled();
  });

  it('maps collection_not_found to 404 and releases the idempotency key', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'collection_not_found' } });
    const res = await collectionsPublicationPostRoute.handler(req({ expectedRevision: 1 }), {} as CloudflareEnv, { id: 'col_missing' }, ctxWith(rpc));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('maps revision_conflict to 409 with currentRevision parsed from the detail string', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=7' } });
    const res = await collectionsPublicationPostRoute.handler(req({ expectedRevision: 3 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(rpc));
    expect(res.status).toBe(409);
    const parsedBody = await res.json();
    expect(parsedBody.code).toBe('REVISION_CONFLICT');
    expect(parsedBody.currentRevision).toBe(7);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('maps draft_required to 422 VALIDATION_FAILED', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'draft_required' } });
    const res = await collectionsPublicationPostRoute.handler(req({ expectedRevision: 0 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(rpc));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('maps missing_polish to 422 MISSING_POLISH', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'missing_polish' } });
    const res = await collectionsPublicationPostRoute.handler(req({ expectedRevision: 1 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(rpc));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('MISSING_POLISH');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('maps product_ref_invalid to 422 VALIDATION_FAILED with fieldErrors.products joined from the invalidIds= detail string (contract requires a string, not an array)', async () => {
    const rpc = vi.fn().mockResolvedValue({
      error: { message: 'product_ref_invalid', details: 'invalidIds=prd_ghost,prd_missing' },
    });
    const res = await collectionsPublicationPostRoute.handler(req({ expectedRevision: 1 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(rpc));
    expect(res.status).toBe(422);
    const parsedBody = await res.json();
    expect(parsedBody.code).toBe('VALIDATION_FAILED');
    expect(parsedBody.fieldErrors).toEqual({ products: 'prd_ghost; prd_missing' });
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('parses a single invalid id in fieldErrors.products (no comma in the detail string)', async () => {
    const rpc = vi.fn().mockResolvedValue({
      error: { message: 'product_ref_invalid', details: 'invalidIds=prd_only_one' },
    });
    const res = await collectionsPublicationPostRoute.handler(req({ expectedRevision: 1 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(rpc));
    const parsedBody = await res.json();
    expect(parsedBody.fieldErrors).toEqual({ products: 'prd_only_one' });
  });

  it('propagates the original publication error even when releasing the idempotency key also fails', async () => {
    const originalError = new Error('boom_original');
    const rpc = vi.fn().mockResolvedValue({ error: originalError });
    // First release call (inside the `if (error)` branch) succeeds; the
    // second (in the outer catch, guarding the rethrow) fails — the original
    // error must still win rather than being masked by the release failure.
    vi.mocked(idempotency.releaseIdempotencyKey)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('release_failed'));
    await expect(
      collectionsPublicationPostRoute.handler(req({ expectedRevision: 1 }), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(rpc)),
    ).rejects.toThrow('boom_original');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalledTimes(2);
  });
});
