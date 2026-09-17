import { describe, expect, it, vi, beforeEach } from 'vitest';
import { uploadsConfirmRoute } from './uploads-confirm';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import * as mapping from '../uploads-mapping';

vi.mock('../idempotency');
vi.mock('../uploads-mapping', () => ({
  getUploadRowById: vi.fn(),
  confirmUploadRow: vi.fn(),
  mapConfirmedUploadToAsset: vi.fn(),
}));

const UPLOAD_ID = '11111111-1111-1111-1111-111111111111';

const pendingRow = {
  id: UPLOAD_ID,
  filename: 'kubek-01.jpg',
  content_type: 'image/jpeg',
  declared_byte_size: 1000,
  ratio: '4:5',
  r2_key: `uploads/${UPLOAD_ID}.jpg`,
  status: 'pending',
  revision: 0,
  confirmed_byte_size: null,
  confirmed_content_type: null,
  created_by: 'anna@studio.pl',
  created_at: '2026-09-17T12:00:00.000Z',
  expires_at: '2026-09-17T12:15:00.000Z',
  updated_at: '2026-09-17T12:00:00.000Z',
};

function req(id: string, body: unknown, idempotencyKey: string | null = 'key-1') {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request(`https://x.test/v1/uploads/${id}/confirm`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctx(): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };
}

function envWithHead(headResult: unknown) {
  return { PRINT_ASSETS: { head: vi.fn().mockResolvedValue(headResult) } } as unknown as CloudflareEnv;
}

describe('uploadsConfirmRoute', () => {
  beforeEach(() => {
    // Mocks are module-level (shared across every test in this file) — clear
    // call history before re-arming the defaults below, so a
    // `.not.toHaveBeenCalled()` assertion in one test can never be satisfied
    // by a lack-of-call in a DIFFERENT, earlier test (see the matching fix in
    // uploads-create.test.ts).
    vi.clearAllMocks();
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(mapping.getUploadRowById).mockResolvedValue(pendingRow as never);
    vi.mocked(mapping.confirmUploadRow).mockResolvedValue({ ...pendingRow, status: 'confirmed', revision: 1 } as never);
    vi.mocked(mapping.mapConfirmedUploadToAsset).mockReturnValue({
      id: UPLOAD_ID,
      name: 'kubek-01.jpg',
      revision: 1,
      status: 'uploaded',
      ratio: '4:5',
      url: 'https://anna-ciok.studio/api/print-assets/uploads/' + UPLOAD_ID,
      usages: [],
      error: '',
    });
  });

  it('404s a malformed (non-uuid) id before doing any other work', async () => {
    const res = await uploadsConfirmRoute.handler(req('not-a-uuid', { expectedRevision: 0 }), envWithHead(null), { id: 'not-a-uuid' }, ctx());
    expect(res.status).toBe(404);
    expect(idempotency.claimIdempotencyKey).not.toHaveBeenCalled();
  });

  it('rejects a request with no Idempotency-Key', async () => {
    const res = await uploadsConfirmRoute.handler(req(UPLOAD_ID, { expectedRevision: 0 }, null), envWithHead(null), { id: UPLOAD_ID }, ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('rejects a non-JSON body', async () => {
    const badReq = new Request(`https://x.test/v1/uploads/${UPLOAD_ID}/confirm`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k' },
      body: 'not json',
    });
    const res = await uploadsConfirmRoute.handler(badReq, envWithHead(null), { id: UPLOAD_ID }, ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a missing expectedRevision', async () => {
    const res = await uploadsConfirmRoute.handler(req(UPLOAD_ID, {}), envWithHead(null), { id: UPLOAD_ID }, ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).fieldErrors).toEqual({ expectedRevision: 'required' });
  });

  it('idempotency replay: returns the stored response and never touches R2', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 200, body: { id: 'cached' } });
    const env = envWithHead(null);
    const res = await uploadsConfirmRoute.handler(req(UPLOAD_ID, { expectedRevision: 0 }), env, { id: UPLOAD_ID }, ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'cached' });
    expect(env.PRINT_ASSETS.head).not.toHaveBeenCalled();
  });

  it('404s and releases the key when the upload row does not exist', async () => {
    vi.mocked(mapping.getUploadRowById).mockResolvedValue(null);
    const res = await uploadsConfirmRoute.handler(req(UPLOAD_ID, { expectedRevision: 0 }), envWithHead(null), { id: UPLOAD_ID }, ctx());
    expect(res.status).toBe(404);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('409s REVISION_CONFLICT and releases the key when expectedRevision does not match', async () => {
    vi.mocked(mapping.getUploadRowById).mockResolvedValue({ ...pendingRow, revision: 1 } as never);
    const res = await uploadsConfirmRoute.handler(req(UPLOAD_ID, { expectedRevision: 0 }), envWithHead(null), { id: UPLOAD_ID }, ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('REVISION_CONFLICT');
    expect(body.currentRevision).toBe(1);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('422s and releases the key when the R2 object does not exist', async () => {
    const res = await uploadsConfirmRoute.handler(req(UPLOAD_ID, { expectedRevision: 0 }), envWithHead(null), { id: UPLOAD_ID }, ctx());
    expect(res.status).toBe(422);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
    expect(mapping.confirmUploadRow).not.toHaveBeenCalled();
  });

  it('422s with a bytes fieldError when the observed size does not match the declared size', async () => {
    const env = envWithHead({ size: 999, httpMetadata: { contentType: 'image/jpeg' } });
    const res = await uploadsConfirmRoute.handler(req(UPLOAD_ID, { expectedRevision: 0 }), env, { id: UPLOAD_ID }, ctx());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fieldErrors.bytes).toBeDefined();
    expect(body.fieldErrors.contentType).toBeUndefined();
    expect(mapping.confirmUploadRow).not.toHaveBeenCalled();
  });

  it('422s with a contentType fieldError when the observed content-type does not match the declared type', async () => {
    const env = envWithHead({ size: 1000, httpMetadata: { contentType: 'image/png' } });
    const res = await uploadsConfirmRoute.handler(req(UPLOAD_ID, { expectedRevision: 0 }), env, { id: UPLOAD_ID }, ctx());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fieldErrors.contentType).toBeDefined();
  });

  it('confirms on a matching R2 object and completes the idempotency key', async () => {
    const env = envWithHead({ size: 1000, httpMetadata: { contentType: 'image/jpeg' } });
    const res = await uploadsConfirmRoute.handler(req(UPLOAD_ID, { expectedRevision: 0 }), env, { id: UPLOAD_ID }, ctx());
    expect(res.status).toBe(200);
    expect(mapping.confirmUploadRow).toHaveBeenCalledWith(expect.anything(), UPLOAD_ID, 0, { byteSize: 1000, contentType: 'image/jpeg' });
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalledWith(
      expect.anything(),
      'uploads:confirm',
      'key-1',
      'lease-1',
      200,
      expect.objectContaining({ id: UPLOAD_ID, status: 'uploaded' }),
    );
  });

  it('409s REVISION_CONFLICT when the final CAS update loses a race, and releases the key', async () => {
    vi.mocked(mapping.confirmUploadRow).mockResolvedValue(null);
    const env = envWithHead({ size: 1000, httpMetadata: { contentType: 'image/jpeg' } });
    const res = await uploadsConfirmRoute.handler(req(UPLOAD_ID, { expectedRevision: 0 }), env, { id: UPLOAD_ID }, ctx());
    expect(res.status).toBe(409);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });
});
