import { describe, expect, it, vi, beforeEach } from 'vitest';
import { uploadsCreateRoute } from './uploads-create';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import * as mapping from '../uploads-mapping';

vi.mock('../idempotency');
vi.mock('../uploads-mapping', () => ({
  UPLOAD_PRESIGN_TTL_SECS: 900,
  buildUploadR2Key: vi.fn((id: string, contentType: string) => `uploads/${id}.${contentType === 'image/png' ? 'png' : 'jpg'}`),
  insertUploadRow: vi.fn(),
  mapUploadRowToIntent: vi.fn(),
  presignUploadPutUrl: vi.fn(),
  resolveR2PresignCredentials: vi.fn(),
}));

const validBody = { filename: 'kubek-01.jpg', contentType: 'image/jpeg', bytes: 1000, ratio: '4:5' };

function req(body: unknown, idempotencyKey: string | null = 'key-1') {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request('https://x.test/v1/uploads', { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctx(): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };
}

const fakeEnv = { PRINT_ASSETS: {} } as unknown as CloudflareEnv;

describe('uploadsCreateRoute', () => {
  beforeEach(() => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(mapping.insertUploadRow).mockResolvedValue({ id: 'up_1', expires_at: '2026-09-17T12:15:00.000Z' } as never);
    vi.mocked(mapping.resolveR2PresignCredentials).mockReturnValue({ accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c' });
    vi.mocked(mapping.presignUploadPutUrl).mockResolvedValue('https://signed.example/put');
    vi.mocked(mapping.mapUploadRowToIntent).mockReturnValue({
      id: 'up_1',
      assetId: 'up_1',
      uploadUrl: 'https://signed.example/put',
      expiresAt: '2026-09-17T12:15:00.000Z',
    });
  });

  it('rejects a request with no Idempotency-Key', async () => {
    const res = await uploadsCreateRoute.handler(req(validBody, null), fakeEnv, {}, ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('rejects a non-JSON body', async () => {
    const badReq = new Request('https://x.test/v1/uploads', { method: 'POST', headers: { 'Idempotency-Key': 'k' }, body: 'not json' });
    const res = await uploadsCreateRoute.handler(badReq, fakeEnv, {}, ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('idempotency replay: same key + same body returns the stored response and never inserts again', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 200, body: { id: 'existing' } });
    const res = await uploadsCreateRoute.handler(req(validBody), fakeEnv, {}, ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'existing' });
    expect(mapping.insertUploadRow).not.toHaveBeenCalled();
  });

  it('returns 409 when the key is already in flight', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'in_progress' });
    const res = await uploadsCreateRoute.handler(req(validBody), fakeEnv, {}, ctx());
    expect(res.status).toBe(409);
  });

  it('returns 422 IDEMPOTENCY_KEY_REUSE for the same key with a different body', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'key_reuse' });
    const res = await uploadsCreateRoute.handler(req({ ...validBody, filename: 'other.jpg' }), fakeEnv, {}, ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('releases the idempotency key and returns 422 VALIDATION_FAILED for an invalid body', async () => {
    const res = await uploadsCreateRoute.handler(req({ ...validBody, contentType: 'image/gif' }), fakeEnv, {}, ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
    expect(mapping.insertUploadRow).not.toHaveBeenCalled();
  });

  it('inserts the row, presigns the PUT URL, and completes the idempotency key on success', async () => {
    const res = await uploadsCreateRoute.handler(req(validBody), fakeEnv, {}, ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'up_1',
      assetId: 'up_1',
      uploadUrl: 'https://signed.example/put',
      expiresAt: '2026-09-17T12:15:00.000Z',
    });

    expect(mapping.insertUploadRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filename: 'kubek-01.jpg',
        contentType: 'image/jpeg',
        bytes: 1000,
        ratio: '4:5',
        createdBy: 'anna@studio.pl',
        r2Key: expect.stringMatching(/^uploads\/.+\.jpg$/),
      }),
    );
    expect(mapping.resolveR2PresignCredentials).toHaveBeenCalledWith(fakeEnv);
    expect(mapping.presignUploadPutUrl).toHaveBeenCalledWith(
      { accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c' },
      expect.stringMatching(/^uploads\/.+\.jpg$/),
    );
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalledWith(
      expect.anything(),
      'uploads:create',
      'key-1',
      'lease-1',
      200,
      expect.objectContaining({ id: 'up_1' }),
    );
  });

  it('releases the idempotency key and propagates the error when R2 credentials are missing', async () => {
    const credError = new Error('Missing R2 S3 credential(s) for upload presigning: R2_S3_ACCOUNT_ID.');
    vi.mocked(mapping.resolveR2PresignCredentials).mockImplementation(() => {
      throw credError;
    });
    await expect(uploadsCreateRoute.handler(req(validBody), fakeEnv, {}, ctx())).rejects.toBe(credError);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });
});
