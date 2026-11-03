import { describe, expect, it, vi, beforeEach } from 'vitest';
import { jobsCreateRoute } from './jobs-create';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import * as uploadsMapping from '../uploads-mapping';
import * as jobsMapping from '../jobs-mapping';
import * as assetJobs from '@/server/asset-jobs/enqueue';

vi.mock('../idempotency');
vi.mock('../uploads-mapping', () => ({ getUploadRowById: vi.fn() }));
vi.mock('../jobs-mapping', () => ({ mapJobRowToResponse: vi.fn() }));
vi.mock('@/server/asset-jobs/enqueue', () => ({ enqueueAssetJob: vi.fn() }));

const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const JOB_ID = '22222222-2222-2222-2222-222222222222';

const confirmedUpload = {
  id: ASSET_ID,
  filename: 'kubek-01.jpg',
  content_type: 'image/jpeg',
  declared_byte_size: 1000,
  ratio: '4:5',
  r2_key: `uploads/${ASSET_ID}.jpg`,
  status: 'confirmed' as const,
  revision: 1,
  confirmed_byte_size: 1000,
  confirmed_content_type: 'image/jpeg',
  created_by: 'anna@studio.pl',
  created_at: '2026-09-17T12:00:00.000Z',
  expires_at: '2026-09-17T12:15:00.000Z',
  updated_at: '2026-09-17T12:05:00.000Z',
};

const jobRow = {
  id: JOB_ID,
  upload_id: ASSET_ID,
  asset_id: null,
  asset_revision: 1,
  status: 'queued' as const,
  attempts: 0,
  idempotency_key: `print-asset-job:${ASSET_ID}:v1`,
  last_error: null,
  created_at: '2026-09-17T12:10:00.000Z',
  updated_at: '2026-09-17T12:10:00.000Z',
};

const jobResponse = { id: JOB_ID, assetId: ASSET_ID, revision: 1, status: 'queued' as const, progress: 0, error: '' };

function req(body: unknown, idempotencyKey: string | null = 'key-1') {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request('https://x.test/v1/jobs', { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctx(): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };
}

const ENV = { ASSET_JOBS_QUEUE: {} } as unknown as CloudflareEnv;

describe('jobsCreateRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(uploadsMapping.getUploadRowById).mockResolvedValue(confirmedUpload as never);
    vi.mocked(assetJobs.enqueueAssetJob).mockResolvedValue(jobRow as never);
    vi.mocked(jobsMapping.mapJobRowToResponse).mockReturnValue(jobResponse);
  });

  it('rejects a request with no Idempotency-Key', async () => {
    const res = await jobsCreateRoute.handler(req({ assetId: ASSET_ID, expectedRevision: 1 }, null), ENV, {}, ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('rejects a non-JSON body', async () => {
    const badReq = new Request('https://x.test/v1/jobs', { method: 'POST', headers: { 'Idempotency-Key': 'k' }, body: 'not json' });
    const res = await jobsCreateRoute.handler(badReq, ENV, {}, ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a missing assetId and expectedRevision with fieldErrors, before claiming idempotency', async () => {
    const res = await jobsCreateRoute.handler(req({}), ENV, {}, ctx());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fieldErrors).toEqual({ assetId: 'required', expectedRevision: 'required' });
    expect(idempotency.claimIdempotencyKey).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID assetId with fieldErrors, before claiming idempotency (would otherwise surface as a 500 from an invalid Postgres uuid comparison)', async () => {
    const res = await jobsCreateRoute.handler(req({ assetId: 'not-a-uuid', expectedRevision: 1 }), ENV, {}, ctx());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fieldErrors).toEqual({ assetId: 'required' });
    expect(idempotency.claimIdempotencyKey).not.toHaveBeenCalled();
  });

  it('idempotency replay: returns the stored response and never touches the upload table', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 202, body: jobResponse });
    const res = await jobsCreateRoute.handler(req({ assetId: ASSET_ID, expectedRevision: 1 }), ENV, {}, ctx());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(jobResponse);
    expect(uploadsMapping.getUploadRowById).not.toHaveBeenCalled();
  });

  it('404s and releases the key when the asset/upload does not exist', async () => {
    vi.mocked(uploadsMapping.getUploadRowById).mockResolvedValue(null);
    const res = await jobsCreateRoute.handler(req({ assetId: ASSET_ID, expectedRevision: 1 }), ENV, {}, ctx());
    expect(res.status).toBe(404);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
    expect(assetJobs.enqueueAssetJob).not.toHaveBeenCalled();
  });

  it('422s and releases the key when the upload is not confirmed yet', async () => {
    vi.mocked(uploadsMapping.getUploadRowById).mockResolvedValue({ ...confirmedUpload, status: 'pending', revision: 0 } as never);
    const res = await jobsCreateRoute.handler(req({ assetId: ASSET_ID, expectedRevision: 0 }), ENV, {}, ctx());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fieldErrors).toEqual({ assetId: 'not confirmed' });
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
    expect(assetJobs.enqueueAssetJob).not.toHaveBeenCalled();
  });

  it('409s REVISION_CONFLICT and releases the key when expectedRevision does not match', async () => {
    const res = await jobsCreateRoute.handler(req({ assetId: ASSET_ID, expectedRevision: 0 }), ENV, {}, ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('REVISION_CONFLICT');
    expect(body.currentRevision).toBe(1);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
    expect(assetJobs.enqueueAssetJob).not.toHaveBeenCalled();
  });

  it('enqueues the job and completes the idempotency key on success (202)', async () => {
    const res = await jobsCreateRoute.handler(req({ assetId: ASSET_ID, expectedRevision: 1 }), ENV, {}, ctx());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(jobResponse);
    expect(assetJobs.enqueueAssetJob).toHaveBeenCalledWith(expect.anything(), ENV, { uploadId: ASSET_ID, assetRevision: 1 });
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalledWith(expect.anything(), 'jobs:create', 'key-1', 'lease-1', 202, jobResponse);
  });

  it('releases the key and rethrows when enqueueAssetJob throws', async () => {
    vi.mocked(assetJobs.enqueueAssetJob).mockRejectedValue(new Error('queue down'));
    await expect(jobsCreateRoute.handler(req({ assetId: ASSET_ID, expectedRevision: 1 }), ENV, {}, ctx())).rejects.toThrow(/queue down/);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });
});
