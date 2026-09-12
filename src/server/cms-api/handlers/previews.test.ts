import { describe, expect, it, vi } from 'vitest';
import { previewsRoute } from './previews';
import type { HandlerContext } from '../router';
import * as mapping from '../mapping';

vi.mock('../mapping');

const ctx: HandlerContext = { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };

function req(body: unknown) {
  return new Request('https://x.test/v1/previews', { method: 'POST', body: JSON.stringify(body) });
}

describe('previewsRoute', () => {
  it('requires resourceId and revision', async () => {
    const res = await previewsRoute.handler(req({}), {} as CloudflareEnv, {}, ctx);
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
});
