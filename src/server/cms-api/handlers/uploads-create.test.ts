import { describe, expect, it, vi, beforeEach } from 'vitest';
import { uploadsCreateRoute } from './uploads-create';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import * as mapping from '../uploads-mapping';
import * as profiles from '@/server/asset-jobs/profiles';

vi.mock('../idempotency');
vi.mock('../uploads-mapping', () => ({
  UPLOAD_PRESIGN_TTL_SECS: 900,
  buildUploadR2Key: vi.fn((id: string, contentType: string) => `uploads/${id}.${contentType === 'image/png' ? 'png' : 'jpg'}`),
  insertUploadRow: vi.fn(),
  mapUploadRowToIntent: vi.fn(),
  presignUploadPutUrl: vi.fn(),
  resolveR2PresignCredentials: vi.fn(),
}));
// Task 12: product-reference validation reuses profiles.ts's
// loadActivePrintVariants (Task 11's "load active print variants for a
// product" logic) rather than inventing a new check — see uploads-create.ts.
vi.mock('@/server/asset-jobs/profiles', () => ({ loadActivePrintVariants: vi.fn() }));

const validBody = { filename: 'kubek-01.jpg', contentType: 'image/jpeg', bytes: 1000, ratio: '4:5', productId: 'print-01' };

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
    // Mocks are module-level (shared across every test in this file) — clear
    // call history AND any per-test mockImplementation/mockRejectedValue
    // override before re-arming the defaults below, so a later test's
    // `.not.toHaveBeenCalled()` assertion reflects only that test's own run,
    // not a prior test's leftover call count.
    vi.clearAllMocks();
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(profiles.loadActivePrintVariants).mockResolvedValue({
      kind: 'ok',
      variants: [{ variantKey: '30x40:false:false:black', w: 3600, h: 4800 }],
    });
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

  // Task 12: productId must resolve to a real, active print product — a 4xx
  // at upload-intent time, not a job that silently fails hours later
  // (process-job.ts's own "no product_id" branch stays as defense-in-depth
  // for pre-existing/malformed rows only, per the task brief).
  it('releases the idempotency key and returns 422 VALIDATION_FAILED (fieldErrors.productId) when the product is not a real active print product', async () => {
    vi.mocked(profiles.loadActivePrintVariants).mockResolvedValue({
      kind: 'invalid',
      message: 'unknown product "nope" — no row in products',
    });
    const res = await uploadsCreateRoute.handler(req({ ...validBody, productId: 'nope' }), fakeEnv, {}, ctx());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors.productId).toMatch(/unknown product/);
    expect(profiles.loadActivePrintVariants).toHaveBeenCalledWith(expect.anything(), 'nope');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
    expect(mapping.insertUploadRow).not.toHaveBeenCalled();
    expect(mapping.resolveR2PresignCredentials).not.toHaveBeenCalled();
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

    expect(profiles.loadActivePrintVariants).toHaveBeenCalledWith(expect.anything(), 'print-01');
    expect(mapping.insertUploadRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filename: 'kubek-01.jpg',
        contentType: 'image/jpeg',
        bytes: 1000,
        ratio: '4:5',
        productId: 'print-01',
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

  // Ordering fix (post-review Finding 1): credential resolution and presign
  // MUST happen before the print_asset_uploads insert, so a misconfigured
  // deployment never leaves an orphaned, unconfirmable row behind — a retry
  // with the same Idempotency-Key would otherwise mint a brand-new
  // crypto.randomUUID() row rather than resuming the failed one (the
  // idempotency ledger only replays what the handler itself completed, not
  // partial DB side effects it made along the way). Asserting
  // insertUploadRow was never called is the genuinely discriminating check
  // here — merely asserting a 500/thrown error would also have passed under
  // the old (buggy) insert-then-presign ordering.
  it('releases the idempotency key, propagates the error, and NEVER inserts a row when R2 credentials are missing', async () => {
    const credError = new Error('Missing R2 S3 credential(s) for upload presigning: R2_S3_ACCOUNT_ID.');
    vi.mocked(mapping.resolveR2PresignCredentials).mockImplementation(() => {
      throw credError;
    });
    await expect(uploadsCreateRoute.handler(req(validBody), fakeEnv, {}, ctx())).rejects.toBe(credError);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
    expect(mapping.insertUploadRow).not.toHaveBeenCalled();
  });

  it('releases the idempotency key, propagates the error, and NEVER inserts a row when presigning itself fails', async () => {
    const presignError = new Error('R2 presign boom');
    vi.mocked(mapping.presignUploadPutUrl).mockRejectedValue(presignError);
    await expect(uploadsCreateRoute.handler(req(validBody), fakeEnv, {}, ctx())).rejects.toBe(presignError);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
    expect(mapping.insertUploadRow).not.toHaveBeenCalled();
  });
});
