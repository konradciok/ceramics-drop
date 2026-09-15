import { describe, expect, it, vi, beforeEach } from 'vitest';
import { collectionsSaveRoute } from './collections-save';
import type { HandlerContext } from '../router';
import * as collectionsMapping from '../collections-mapping';

vi.mock('../collections-mapping');

const validFields = [
  { key: 'description', label: 'Opis kolekcji', type: 'text', value: 'Nowy opis', locale: 'pl', sourceLocale: 'pl' },
  { key: 'products', label: 'Produkty i kolejność', type: 'productIds', value: '', locale: 'none', sourceLocale: 'none' },
];

function req(body: unknown) {
  return new Request('https://x.test/v1/collections/col_1', { method: 'PUT', body: JSON.stringify(body) });
}

function ctxWith(rpc: ReturnType<typeof vi.fn>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: { rpc } as never };
}

describe('collectionsSaveRoute', () => {
  beforeEach(() => {
    vi.mocked(collectionsMapping.loadCollectionResponse).mockResolvedValue({
      id: 'col_1',
      kind: 'collections',
      name: 'Nowa nazwa',
      revision: 2,
      publishedRevision: null,
      fields: validFields,
    } as never);
  });

  it('requires expectedRevision', async () => {
    const res = await collectionsSaveRoute.handler(
      req({ name: 'Nowa nazwa', fields: validFields }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(vi.fn()),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a null JSON body', async () => {
    const res = await collectionsSaveRoute.handler(req(null), {} as CloudflareEnv, { id: 'col_1' }, ctxWith(vi.fn()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a body with a draft wrapper (no draft key in ResourceSave)', async () => {
    const res = await collectionsSaveRoute.handler(
      req({ expectedRevision: 1, draft: { name: 'Nowa nazwa', fields: validFields } }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(vi.fn()),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('validates fields', async () => {
    const res = await collectionsSaveRoute.handler(
      req({ expectedRevision: 1, name: 'Nowa nazwa', fields: [{ key: 'x' }] }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(vi.fn()),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('maps a collection_not_found RPC error to 404', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'collection_not_found' } });
    const res = await collectionsSaveRoute.handler(
      req({ expectedRevision: 1, name: 'Nowa nazwa', fields: validFields }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(rpc),
    );
    expect(res.status).toBe(404);
  });

  it('maps a revision_conflict RPC error to 409 with currentRevision extracted from details', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'revision_conflict', details: 'currentRevision=5' } });
    const res = await collectionsSaveRoute.handler(
      req({ expectedRevision: 1, name: 'Nowa nazwa', fields: validFields }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(rpc),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(5);
  });

  it('saves successfully and returns the reloaded collection', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await collectionsSaveRoute.handler(
      req({ expectedRevision: 1, name: 'Nowa nazwa', fields: validFields }),
      {} as CloudflareEnv,
      { id: 'col_1' },
      ctxWith(rpc),
    );
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('save_collection_draft', {
      p_collection_id: 'col_1',
      p_expected_revision: 1,
      p_payload: { name: 'Nowa nazwa', fields: validFields },
      p_actor_email: 'anna@studio.pl',
    });
  });
});
