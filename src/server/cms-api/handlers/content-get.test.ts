import { describe, expect, it, vi } from 'vitest';
import { contentGetRoute } from './content-get';
import type { HandlerContext } from '../router';
import * as contentMapping from '../content-mapping';

vi.mock('../content-mapping');

function ctxFor(): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };
}

describe('contentGetRoute', () => {
  it('returns 404 for a malformed resource id', async () => {
    const res = await contentGetRoute.handler(
      new Request('https://x.test/v1/content/not-a-valid-id'),
      {} as CloudflareEnv,
      { id: 'not-a-valid-id' },
      ctxFor(),
    );
    expect(res.status).toBe(404);
    expect(contentMapping.loadContentResource).not.toHaveBeenCalled();
  });

  it('returns 404 when the decoded document/locale does not resolve to a resource', async () => {
    vi.mocked(contentMapping.decodeContentResourceId).mockReturnValue({ kind: 'product_notes', slug: 'kubki', locale: 'pl' });
    vi.mocked(contentMapping.loadContentResource).mockResolvedValue(null);
    const res = await contentGetRoute.handler(
      new Request('https://x.test/v1/content/product_notes:kubki:pl'),
      {} as CloudflareEnv,
      { id: 'product_notes:kubki:pl' },
      ctxFor(),
    );
    expect(res.status).toBe(404);
  });

  it('returns the mapped content resource on success', async () => {
    vi.mocked(contentMapping.decodeContentResourceId).mockReturnValue({ kind: 'product_notes', slug: 'kubki', locale: 'pl' });
    vi.mocked(contentMapping.loadContentResource).mockResolvedValue({
      id: 'product_notes:kubki:pl',
      kind: 'content',
      name: 'kubki',
      revision: 2,
      publishedRevision: 1,
      fields: [],
    });
    const ctx = ctxFor();
    const res = await contentGetRoute.handler(
      new Request('https://x.test/v1/content/product_notes:kubki:pl'),
      {} as CloudflareEnv,
      { id: 'product_notes:kubki:pl' },
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('product_notes:kubki:pl');
    expect(body.revision).toBe(2);
    expect(contentMapping.loadContentResource).toHaveBeenCalledWith('product_notes', 'kubki', 'pl', ctx.supabase);
  });
});
