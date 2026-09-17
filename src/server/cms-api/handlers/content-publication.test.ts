import { describe, expect, it, vi, beforeEach } from 'vitest';
import { contentPublicationPostRoute } from './content-publication';
import type { HandlerContext } from '../router';
import * as contentMapping from '../content-mapping';
import * as adminContent from '@/lib/admin/content';
import * as idempotency from '../idempotency';

vi.mock('../content-mapping');
vi.mock('@/lib/admin/content');
vi.mock('../idempotency');

const decoded = { kind: 'product_notes' as const, slug: 'kubki', locale: 'pl' as const };
const currentResource = { id: 'product_notes:kubki:pl', kind: 'content' as const, name: 'kubki', revision: 2, publishedRevision: 1, fields: [] };

function req(body: unknown, headers: Record<string, string> = { 'Idempotency-Key': 'idem-1' }) {
  return new Request('https://x.test/v1/content/product_notes:kubki:pl/publication', { method: 'POST', body: JSON.stringify(body), headers });
}

function ctxFor(): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };
}

describe('contentPublicationPostRoute', () => {
  beforeEach(() => {
    vi.mocked(contentMapping.decodeContentResourceId).mockReturnValue(decoded);
    vi.mocked(contentMapping.loadContentResource).mockResolvedValue(currentResource);
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(adminContent.publishVersion).mockResolvedValue({
      id: 'v2', document_id: 'doc_1', locale: 'pl', version: 2, status: 'published', payload: { notes: {} }, created_by: null, created_at: '',
    });
  });

  it('returns 404 for a malformed resource id before requiring an Idempotency-Key', async () => {
    vi.mocked(contentMapping.decodeContentResourceId).mockReturnValue(null);
    const res = await contentPublicationPostRoute.handler(req({ expectedRevision: 2 }, {}), {} as CloudflareEnv, { id: 'bad' }, ctxFor());
    expect(res.status).toBe(404);
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await contentPublicationPostRoute.handler(req({ expectedRevision: 2 }, {}), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('requires an integer expectedRevision', async () => {
    const res = await contentPublicationPostRoute.handler(req({}), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(422);
  });

  it('replays a completed idempotent request without re-publishing', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 200, body: { id: 'cached' } });
    const res = await contentPublicationPostRoute.handler(req({ expectedRevision: 2 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'cached' });
    expect(adminContent.publishVersion).not.toHaveBeenCalled();
  });

  it('returns 409 IDEMPOTENCY_IN_PROGRESS for a concurrent in-flight request', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'in_progress' });
    const res = await contentPublicationPostRoute.handler(req({ expectedRevision: 2 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(409);
  });

  it('returns 422 IDEMPOTENCY_KEY_REUSE for a reused key with a different body', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'key_reuse' });
    const res = await contentPublicationPostRoute.handler(req({ expectedRevision: 2 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('maps a stale expectedRevision to 409 REVISION_CONFLICT and releases the idempotency lease', async () => {
    const res = await contentPublicationPostRoute.handler(req({ expectedRevision: 1 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(2);
    expect(adminContent.publishVersion).not.toHaveBeenCalled();
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('returns 404 when the content resource does not exist', async () => {
    vi.mocked(contentMapping.loadContentResource).mockResolvedValue(null);
    const res = await contentPublicationPostRoute.handler(req({ expectedRevision: 2 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(404);
  });

  it('publishes the current revision and completes the idempotency key', async () => {
    const res = await contentPublicationPostRoute.handler(req({ expectedRevision: 2 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(200);
    expect(adminContent.publishVersion).toHaveBeenCalledWith({
      kind: 'product_notes',
      slug: 'kubki',
      locale: 'pl',
      version: 2,
      actorEmail: 'anna@studio.pl',
    });
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalled();
  });

  it('maps a version_not_found error from publishVersion to 404', async () => {
    vi.mocked(adminContent.publishVersion).mockRejectedValue(new Error('version_not_found'));
    const res = await contentPublicationPostRoute.handler(req({ expectedRevision: 2 }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(404);
  });

  it('rethrows an unrecognized publishVersion error', async () => {
    vi.mocked(adminContent.publishVersion).mockRejectedValue(new Error('boom'));
    await expect(
      contentPublicationPostRoute.handler(req({ expectedRevision: 2 }), {} as CloudflareEnv, { id: 'x' }, ctxFor()),
    ).rejects.toThrow('boom');
  });
});
