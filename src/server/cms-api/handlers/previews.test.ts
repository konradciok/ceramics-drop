import { describe, expect, it, vi } from 'vitest';
import { previewsRoute } from './previews';
import type { HandlerContext } from '../router';
import * as mapping from '../mapping';
import * as contentMapping from '../content-mapping';

vi.mock('../mapping');
vi.mock('../content-mapping', async () => {
  const actual = await vi.importActual<typeof import('../content-mapping')>('../content-mapping');
  return { ...actual, loadContentResource: vi.fn() };
});

const ctx: HandlerContext = { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };

function req(body: unknown) {
  return new Request('https://x.test/v1/previews', { method: 'POST', body: JSON.stringify(body) });
}

describe('previewsRoute', () => {
  it('requires resourceId and revision', async () => {
    const res = await previewsRoute.handler(req({}), {} as CloudflareEnv, {}, ctx);
    expect(res.status).toBe(422);
  });

  it.each([
    ['fractional', 1.5],
    ['negative', -1],
    ['infinite', Infinity],
    ['NaN', NaN],
  ])('rejects a %s revision with 422', async (_label, revision) => {
    const res = await previewsRoute.handler(req({ resourceId: 'prd_1', revision }), {} as CloudflareEnv, {}, ctx);
    expect(res.status).toBe(422);
  });

  it('returns 404 when the product does not exist', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue(null);
    const res = await previewsRoute.handler(req({ resourceId: 'prd_1', revision: 1 }), {} as CloudflareEnv, {}, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 503 NOT_IMPLEMENTED when CMS_PREVIEW_SECRET is unset', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue({ type: 'ceramic', draft: { category: 'kubki' } } as never);
    const res = await previewsRoute.handler(req({ resourceId: 'prd_1', revision: 1 }), {} as CloudflareEnv, {}, ctx);
    expect(res.status).toBe(503);
  });

  it('mints a preview URL and expiry when configured', async () => {
    vi.mocked(mapping.loadProductResponse).mockResolvedValue({ type: 'ceramic', draft: { category: 'kubki' } } as never);
    const res = await previewsRoute.handler(
      req({ resourceId: 'prd_1', revision: 1 }),
      { CMS_PREVIEW_SECRET: 'secret' } as CloudflareEnv,
      {},
      ctx,
    );
    const body = await res.json();
    expect(body.url).toContain('/kubki/prd_1?preview=');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  // Task 5 — content preview. A content-shaped resourceId ("${kind}:${slug}:
  // ${locale}") never reaches loadProductResponse; it decodes as content and
  // mints via mintContentPreviewToken instead.
  describe('content-shaped resourceId', () => {
    it('returns 404 when the content resource does not exist, without calling loadProductResponse', async () => {
      vi.mocked(mapping.loadProductResponse).mockClear();
      vi.mocked(contentMapping.loadContentResource).mockResolvedValue(null);
      const res = await previewsRoute.handler(req({ resourceId: 'product_notes:kubki:pl', revision: 1 }), {} as CloudflareEnv, {}, ctx);
      expect(res.status).toBe(404);
      expect(mapping.loadProductResponse).not.toHaveBeenCalled();
    });

    it('returns 503 NOT_IMPLEMENTED when CMS_PREVIEW_SECRET is unset', async () => {
      vi.mocked(contentMapping.loadContentResource).mockResolvedValue({
        id: 'product_notes:kubki:pl',
        kind: 'content',
        name: 'kubki',
        revision: 1,
        publishedRevision: null,
        fields: [],
      });
      const res = await previewsRoute.handler(req({ resourceId: 'product_notes:kubki:pl', revision: 1 }), {} as CloudflareEnv, {}, ctx);
      expect(res.status).toBe(503);
    });

    it('mints a locale-prefixed preview URL using the resource id own locale', async () => {
      vi.mocked(contentMapping.loadContentResource).mockResolvedValue({
        id: 'product_notes:kubki:es',
        kind: 'content',
        name: 'kubki',
        revision: 2,
        publishedRevision: null,
        fields: [],
      });
      const res = await previewsRoute.handler(
        req({ resourceId: 'product_notes:kubki:es', revision: 2 }),
        { CMS_PREVIEW_SECRET: 'secret' } as CloudflareEnv,
        {},
        ctx,
      );
      const body = await res.json();
      expect(body.url).toContain('/es/kubki?preview=');
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('threads ctx.supabase into loadContentResource, not content.ts\'s default client', async () => {
      vi.mocked(contentMapping.loadContentResource).mockResolvedValue({
        id: 'product_notes:kubki:pl',
        kind: 'content',
        name: 'kubki',
        revision: 1,
        publishedRevision: null,
        fields: [],
      });
      await previewsRoute.handler(req({ resourceId: 'product_notes:kubki:pl', revision: 1 }), {} as CloudflareEnv, {}, ctx);
      expect(contentMapping.loadContentResource).toHaveBeenCalledWith('product_notes', 'kubki', 'pl', ctx.supabase);
    });

    it('mints a preview URL for the home document at the site root', async () => {
      vi.mocked(contentMapping.loadContentResource).mockResolvedValue({
        id: 'page:home:pl',
        kind: 'content',
        name: 'Strona główna — hero',
        revision: 1,
        publishedRevision: null,
        fields: [],
      });
      const res = await previewsRoute.handler(
        req({ resourceId: 'page:home:pl', revision: 1 }),
        { CMS_PREVIEW_SECRET: 'secret' } as CloudflareEnv,
        {},
        ctx,
      );
      const body = await res.json();
      expect(body.url).toContain('/pl/?preview=');
    });
  });
});
