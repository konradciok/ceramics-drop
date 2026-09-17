import { describe, expect, it, vi, beforeEach } from 'vitest';
import { contentRestorePostRoute } from './content-restore';
import type { HandlerContext } from '../router';
import * as contentMapping from '../content-mapping';
import * as adminContent from '@/lib/admin/content';
import * as idempotency from '../idempotency';

vi.mock('../content-mapping');
vi.mock('@/lib/admin/content');
vi.mock('../idempotency');

const decoded = { kind: 'product_notes' as const, slug: 'kubki', locale: 'pl' as const };
const currentResource = { id: 'product_notes:kubki:pl', kind: 'content' as const, name: 'kubki', revision: 3, publishedRevision: 1, fields: [] };

function req(body: unknown, headers: Record<string, string> = { 'Idempotency-Key': 'idem-1' }) {
  return new Request('https://x.test/v1/content/product_notes:kubki:pl/restore', { method: 'POST', body: JSON.stringify(body), headers });
}

function ctxFor(): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };
}

describe('contentRestorePostRoute', () => {
  beforeEach(() => {
    vi.mocked(contentMapping.decodeContentResourceId).mockReturnValue(decoded);
    vi.mocked(contentMapping.loadContentResource).mockResolvedValue(currentResource);
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(adminContent.revertVersion).mockResolvedValue({
      id: 'v4', document_id: 'doc_1', locale: 'pl', version: 4, status: 'draft', payload: { notes: {} }, created_by: null, created_at: '',
    });
  });

  it('returns 404 for a malformed resource id', async () => {
    vi.mocked(contentMapping.decodeContentResourceId).mockReturnValue(null);
    const res = await contentRestorePostRoute.handler(req({ expectedRevision: 3, sourceRevision: 1 }, {}), {} as CloudflareEnv, { id: 'bad' }, ctxFor());
    expect(res.status).toBe(404);
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await contentRestorePostRoute.handler(req({ expectedRevision: 3, sourceRevision: 1 }, {}), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('requires expectedRevision and sourceRevision', async () => {
    const res1 = await contentRestorePostRoute.handler(req({ sourceRevision: 1 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res1.status).toBe(422);
    const res2 = await contentRestorePostRoute.handler(req({ expectedRevision: 3 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res2.status).toBe(422);
  });

  it('maps a stale expectedRevision to 409 REVISION_CONFLICT', async () => {
    const res = await contentRestorePostRoute.handler(req({ expectedRevision: 1, sourceRevision: 1 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(3);
    expect(adminContent.revertVersion).not.toHaveBeenCalled();
  });

  it('returns 404 when the content resource does not exist', async () => {
    vi.mocked(contentMapping.loadContentResource).mockResolvedValue(null);
    const res = await contentRestorePostRoute.handler(req({ expectedRevision: 3, sourceRevision: 1 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(404);
  });

  it('restores the source revision as a new draft and completes the idempotency key', async () => {
    const res = await contentRestorePostRoute.handler(req({ expectedRevision: 3, sourceRevision: 1 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(200);
    expect(adminContent.revertVersion).toHaveBeenCalledWith({
      kind: 'product_notes',
      slug: 'kubki',
      locale: 'pl',
      version: 1,
      actorEmail: 'anna@studio.pl',
    });
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalled();
  });

  it('maps a version_not_found error from revertVersion to 404 naming the missing source revision', async () => {
    vi.mocked(adminContent.revertVersion).mockRejectedValue(new Error('version_not_found'));
    const res = await contentRestorePostRoute.handler(req({ expectedRevision: 3, sourceRevision: 99 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(404);
    expect((await res.json()).message).toContain('99');
  });

  it('rethrows an unrecognized revertVersion error', async () => {
    vi.mocked(adminContent.revertVersion).mockRejectedValue(new Error('boom'));
    await expect(
      contentRestorePostRoute.handler(req({ expectedRevision: 3, sourceRevision: 1 }), {} as CloudflareEnv, { id: 'x' }, ctxFor()),
    ).rejects.toThrow('boom');
  });
});
