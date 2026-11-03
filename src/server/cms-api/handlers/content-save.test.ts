import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { contentSaveRoute } from './content-save';
import type { HandlerContext } from '../router';
import * as contentMapping from '../content-mapping';
import * as adminContent from '@/lib/admin/content';

vi.mock('../content-mapping');
vi.mock('@/lib/admin/content');

const validField = { key: 'kubki-01', label: 'Kubki Nº 01', type: 'text' as const, value: 'A note', locale: 'none' as const, sourceLocale: 'none' as const };

function req(body: unknown) {
  return new Request('https://x.test/v1/content/product_notes:kubki:pl', { method: 'PUT', body: JSON.stringify(body) });
}

function ctxFor(): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };
}

const decoded = { kind: 'product_notes' as const, slug: 'kubki', locale: 'pl' as const };
const currentState = {
  resource: { id: 'product_notes:kubki:pl', kind: 'content' as const, name: 'kubki', revision: 1, publishedRevision: null, fields: [validField] },
  payload: { notes: { 'kubki-01': 'Old note' } },
};

describe('contentSaveRoute', () => {
  beforeEach(() => {
    vi.mocked(contentMapping.decodeContentResourceId).mockReturnValue(decoded);
    vi.mocked(contentMapping.loadContentResourceState).mockResolvedValue(currentState);
    vi.mocked(contentMapping.unflattenContentFields).mockReturnValue({ notes: { 'kubki-01': 'A note' } });
    vi.mocked(contentMapping.loadContentResource).mockResolvedValue({
      id: 'product_notes:kubki:pl',
      kind: 'content',
      name: 'kubki',
      revision: 2,
      publishedRevision: null,
      fields: [validField],
    });
    vi.mocked(adminContent.saveDraft).mockResolvedValue({
      id: 'v2',
      document_id: 'doc_1',
      locale: 'pl',
      version: 2,
      status: 'draft',
      payload: { notes: {} },
      created_by: null,
      created_at: '',
    });
  });

  it('returns 404 for a malformed resource id without reading any state', async () => {
    vi.mocked(contentMapping.decodeContentResourceId).mockReturnValue(null);
    const res = await contentSaveRoute.handler(req({ expectedRevision: 1, name: 'kubki', fields: [validField] }), {} as CloudflareEnv, { id: 'bad' }, ctxFor());
    expect(res.status).toBe(404);
    expect(contentMapping.loadContentResourceState).not.toHaveBeenCalled();
  });

  it('rejects a null JSON body', async () => {
    const res = await contentSaveRoute.handler(req(null), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(422);
  });

  it('requires expectedRevision', async () => {
    const res = await contentSaveRoute.handler(req({ name: 'kubki', fields: [validField] }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('maps a stale expectedRevision to 409 REVISION_CONFLICT with the current revision', async () => {
    const res = await contentSaveRoute.handler(req({ expectedRevision: 0, name: 'kubki', fields: [validField] }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(409);
    expect((await res.json()).currentRevision).toBe(1);
    expect(adminContent.saveDraft).not.toHaveBeenCalled();
  });

  it('passes the current payload through to unflattenContentFields (for home media preservation)', async () => {
    await contentSaveRoute.handler(req({ expectedRevision: 1, name: 'kubki', fields: [validField] }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(contentMapping.unflattenContentFields).toHaveBeenCalledWith({ kind: 'product_notes', slug: 'kubki' }, [validField], currentState.payload);
  });

  it('calls saveDraft with the decoded kind/slug/locale and unflattened payload', async () => {
    const ctx = ctxFor();
    await contentSaveRoute.handler(req({ expectedRevision: 1, name: 'kubki', fields: [validField] }), {} as CloudflareEnv, { id: 'x' }, ctx);
    expect(adminContent.saveDraft).toHaveBeenCalledWith({
      kind: 'product_notes',
      slug: 'kubki',
      locale: 'pl',
      payload: { notes: { 'kubki-01': 'A note' } },
      actorEmail: 'anna@studio.pl',
      client: ctx.supabase,
    });
  });

  it('threads ctx.supabase into loadContentResourceState and loadContentResource, not content.ts\'s default client', async () => {
    const ctx = ctxFor();
    await contentSaveRoute.handler(req({ expectedRevision: 1, name: 'kubki', fields: [validField] }), {} as CloudflareEnv, { id: 'x' }, ctx);
    expect(contentMapping.loadContentResourceState).toHaveBeenCalledWith('product_notes', 'kubki', 'pl', ctx.supabase);
    expect(contentMapping.loadContentResource).toHaveBeenCalledWith('product_notes', 'kubki', 'pl', ctx.supabase);
  });

  it('never persists the client-submitted name (content.ts has no name slot)', async () => {
    await contentSaveRoute.handler(req({ expectedRevision: 1, name: 'Tampered Name', fields: [validField] }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    const call = vi.mocked(adminContent.saveDraft).mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('name');
  });

  it('returns the reloaded resource on success', async () => {
    const res = await contentSaveRoute.handler(req({ expectedRevision: 1, name: 'kubki', fields: [validField] }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revision).toBe(2);
  });

  it('maps a ZodError thrown by saveDraft (content.ts payload validation) to 422 with fieldErrors', async () => {
    vi.mocked(adminContent.saveDraft).mockRejectedValue(
      new z.ZodError([{ code: 'custom', path: ['notes', 'kubki-02'], message: 'Brak opisu dla kubki-02', input: undefined }]),
    );
    const res = await contentSaveRoute.handler(req({ expectedRevision: 1, name: 'kubki', fields: [validField] }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fieldErrors).toHaveProperty('notes.kubki-02');
  });

  it('maps a document_not_found error from saveDraft to 404', async () => {
    vi.mocked(adminContent.saveDraft).mockRejectedValue(new Error('document_not_found'));
    const res = await contentSaveRoute.handler(req({ expectedRevision: 1, name: 'kubki', fields: [validField] }), {} as CloudflareEnv, { id: 'x' }, ctxFor());
    expect(res.status).toBe(404);
  });

  it('rethrows an unrecognized saveDraft error', async () => {
    vi.mocked(adminContent.saveDraft).mockRejectedValue(new Error('boom'));
    await expect(
      contentSaveRoute.handler(req({ expectedRevision: 1, name: 'kubki', fields: [validField] }), {} as CloudflareEnv, { id: 'x' }, ctxFor()),
    ).rejects.toThrow('boom');
  });
});
