import { describe, expect, it, vi, beforeEach } from 'vitest';
import { collectionsCreateRoute } from './collections-create';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import * as mapping from '../collections-mapping';

vi.mock('../idempotency');
vi.mock('../collections-mapping');

const validBody = { name: 'Spokojne formy' };

function req(body: unknown, idempotencyKey: string | null = 'key-1') {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request('https://x.test/v1/collections', { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

describe('collectionsCreateRoute', () => {
  beforeEach(() => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(mapping.loadCollectionResponse).mockResolvedValue({ id: 'col_abc' } as never);
  });

  it('rejects a request with no Idempotency-Key', async () => {
    const res = await collectionsCreateRoute.handler(req(validBody, null), {} as CloudflareEnv, {}, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('idempotency replay: same key + same body returns the stored response and never calls the RPC again', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 200, body: { id: 'col_existing' } });
    const rpc = vi.fn();
    const res = await collectionsCreateRoute.handler(req(validBody), {} as CloudflareEnv, {}, ctxWith(rpc));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'col_existing' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns 409 when the key is already in flight', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'in_progress' });
    const res = await collectionsCreateRoute.handler(req(validBody), {} as CloudflareEnv, {}, ctxWith(vi.fn()));
    expect(res.status).toBe(409);
  });

  it('key reuse: same key + a different body returns 422 IDEMPOTENCY_KEY_REUSE (the idempotency layer\'s actual conflict response)', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'key_reuse' });
    const res = await collectionsCreateRoute.handler(req({ name: 'A different name' }), {} as CloudflareEnv, {}, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('releases the idempotency key and returns 422 on an invalid body (blank name)', async () => {
    const res = await collectionsCreateRoute.handler(req({ name: '   ' }), {} as CloudflareEnv, {}, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('creates the collection with a col_-prefixed id, seeds exactly 5 default fields, and completes the idempotency key on success', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await collectionsCreateRoute.handler(req(validBody), {} as CloudflareEnv, {}, ctxWith(rpc));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      'create_collection_with_draft',
      expect.objectContaining({
        p_id: expect.stringMatching(/^col_[0-9a-f]{10}$/),
        p_actor_email: 'anna@studio.pl',
        p_payload: expect.objectContaining({ name: 'Spokojne formy' }),
      }),
    );

    const payload = rpc.mock.calls[0][1].p_payload as { name: string; fields: Array<Record<string, unknown>> };
    expect(payload.fields).toHaveLength(5);

    const descriptionFields = payload.fields.filter((f) => f.type === 'text');
    expect(descriptionFields).toHaveLength(4);
    expect(descriptionFields.map((f) => f.locale).sort()).toEqual(['de', 'en', 'es', 'pl']);
    for (const field of descriptionFields) {
      expect(field.value).toBe('');
    }

    const productIdsFields = payload.fields.filter((f) => f.type === 'productIds');
    expect(productIdsFields).toHaveLength(1);
    expect(productIdsFields[0].locale).toBe('none');
    expect(productIdsFields[0].value).toBe('');

    expect(idempotency.completeIdempotencyKey).toHaveBeenCalledWith(
      expect.anything(),
      'collections:create',
      'key-1',
      'lease-1',
      200,
      { id: 'col_abc' },
    );
  });

  it('retries with a new id on a 23505 unique_violation and releases the lease if all retries fail', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });
    await expect(collectionsCreateRoute.handler(req(validBody), {} as CloudflareEnv, {}, ctxWith(rpc))).rejects.toBeTruthy();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });
});
