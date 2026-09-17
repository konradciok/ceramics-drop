import { describe, expect, it, vi, beforeEach } from 'vitest';
import { jobsRetryRoute } from './jobs-retry';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import * as jobsMapping from '../jobs-mapping';
import * as assetJobs from '@/server/asset-jobs/enqueue';

vi.mock('../idempotency');
vi.mock('../jobs-mapping', () => ({
  getJobRowById: vi.fn(),
  requeueJobRow: vi.fn(),
  mapJobRowToResponse: vi.fn(),
}));
vi.mock('@/server/asset-jobs/enqueue', () => ({ sendAssetJobMessage: vi.fn() }));

const JOB_ID = '22222222-2222-2222-2222-222222222222';
const UPLOAD_ID = '11111111-1111-1111-1111-111111111111';

const failedRow = {
  id: JOB_ID,
  upload_id: UPLOAD_ID,
  asset_id: null,
  asset_revision: 1,
  status: 'failed_retryable' as const,
  attempts: 1,
  idempotency_key: `print-asset-job:${UPLOAD_ID}:v1`,
  last_error: 'R2 head failed',
  created_at: '2026-09-17T12:00:00.000Z',
  updated_at: '2026-09-17T12:05:00.000Z',
};

const requeuedRow = { ...failedRow, status: 'queued' as const, last_error: null };
const jobResponse = { id: JOB_ID, assetId: UPLOAD_ID, revision: 1, status: 'queued' as const, progress: 0, error: '' };

function req(id: string, body: unknown, idempotencyKey: string | null = 'key-1') {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request(`https://x.test/v1/jobs/${id}/retry`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctx(): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };
}

const ENV = { ASSET_JOBS_QUEUE: {} } as unknown as CloudflareEnv;

describe('jobsRetryRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(jobsMapping.getJobRowById).mockResolvedValue(failedRow as never);
    vi.mocked(jobsMapping.requeueJobRow).mockResolvedValue(requeuedRow as never);
    vi.mocked(jobsMapping.mapJobRowToResponse).mockReturnValue(jobResponse);
    vi.mocked(assetJobs.sendAssetJobMessage).mockResolvedValue(undefined);
  });

  it('404s a malformed (non-uuid) id before doing any other work', async () => {
    const res = await jobsRetryRoute.handler(req('not-a-uuid', { expectedRevision: 1 }), ENV, { id: 'not-a-uuid' }, ctx());
    expect(res.status).toBe(404);
    expect(idempotency.claimIdempotencyKey).not.toHaveBeenCalled();
  });

  it('rejects a request with no Idempotency-Key', async () => {
    const res = await jobsRetryRoute.handler(req(JOB_ID, { expectedRevision: 1 }, null), ENV, { id: JOB_ID }, ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('rejects a missing expectedRevision', async () => {
    const res = await jobsRetryRoute.handler(req(JOB_ID, {}), ENV, { id: JOB_ID }, ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).fieldErrors).toEqual({ expectedRevision: 'required' });
  });

  it('idempotency replay: returns the stored response and never touches the job table', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 202, body: jobResponse });
    const res = await jobsRetryRoute.handler(req(JOB_ID, { expectedRevision: 1 }), ENV, { id: JOB_ID }, ctx());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(jobResponse);
    expect(jobsMapping.getJobRowById).not.toHaveBeenCalled();
  });

  it('404s and releases the key when the job does not exist', async () => {
    vi.mocked(jobsMapping.getJobRowById).mockResolvedValue(null);
    const res = await jobsRetryRoute.handler(req(JOB_ID, { expectedRevision: 1 }), ENV, { id: JOB_ID }, ctx());
    expect(res.status).toBe(404);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('409s REVISION_CONFLICT and releases the key when expectedRevision does not match', async () => {
    const res = await jobsRetryRoute.handler(req(JOB_ID, { expectedRevision: 2 }), ENV, { id: JOB_ID }, ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('REVISION_CONFLICT');
    expect(body.currentRevision).toBe(1);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('422s and releases the key when the job is not in a retryable state', async () => {
    vi.mocked(jobsMapping.getJobRowById).mockResolvedValue({ ...failedRow, status: 'queued' } as never);
    const res = await jobsRetryRoute.handler(req(JOB_ID, { expectedRevision: 1 }), ENV, { id: JOB_ID }, ctx());
    expect(res.status).toBe(422);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
    expect(jobsMapping.requeueJobRow).not.toHaveBeenCalled();
  });

  it('accepts retry from failed_action_required too', async () => {
    vi.mocked(jobsMapping.getJobRowById).mockResolvedValue({ ...failedRow, status: 'failed_action_required' } as never);
    const res = await jobsRetryRoute.handler(req(JOB_ID, { expectedRevision: 1 }), ENV, { id: JOB_ID }, ctx());
    expect(res.status).toBe(202);
  });

  it('409s when the requeue CAS loses the race, and releases the key', async () => {
    vi.mocked(jobsMapping.requeueJobRow).mockResolvedValue(null);
    const res = await jobsRetryRoute.handler(req(JOB_ID, { expectedRevision: 1 }), ENV, { id: JOB_ID }, ctx());
    expect(res.status).toBe(409);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
    expect(assetJobs.sendAssetJobMessage).not.toHaveBeenCalled();
  });

  it('requeues, re-sends the queue message with the SAME job id, and completes the idempotency key on success (202)', async () => {
    const res = await jobsRetryRoute.handler(req(JOB_ID, { expectedRevision: 1 }), ENV, { id: JOB_ID }, ctx());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(jobResponse);
    expect(assetJobs.sendAssetJobMessage).toHaveBeenCalledWith(ENV, { jobId: JOB_ID, uploadId: UPLOAD_ID });
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalledWith(expect.anything(), 'jobs:retry', 'key-1', 'lease-1', 202, jobResponse);
  });

  it('releases the key and rethrows when sendAssetJobMessage throws', async () => {
    vi.mocked(assetJobs.sendAssetJobMessage).mockRejectedValue(new Error('queue down'));
    await expect(jobsRetryRoute.handler(req(JOB_ID, { expectedRevision: 1 }), ENV, { id: JOB_ID }, ctx())).rejects.toThrow(/queue down/);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });
});
