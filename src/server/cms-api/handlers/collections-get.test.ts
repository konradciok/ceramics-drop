import { describe, expect, it, vi } from 'vitest';
import { collectionsGetRoute } from './collections-get';
import type { HandlerContext } from '../router';

vi.mock('../collections-mapping', () => ({
  loadCollectionResponse: vi.fn(async (_supabase: unknown, id: string) => (id === 'col_1' ? { id: 'col_1', kind: 'collections' } : null)),
}));

const ctx: HandlerContext = { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };

describe('collectionsGetRoute', () => {
  it('returns the collection when found', async () => {
    const res = await collectionsGetRoute.handler(new Request('https://x.test/v1/collections/col_1'), {} as CloudflareEnv, { id: 'col_1' }, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('col_1');
    expect(body.kind).toBe('collections');
  });

  it('returns 404 NOT_FOUND when the collection does not exist', async () => {
    const res = await collectionsGetRoute.handler(new Request('https://x.test/v1/collections/nope'), {} as CloudflareEnv, { id: 'nope' }, ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });
});
