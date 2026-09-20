import { describe, expect, it, vi, beforeEach } from 'vitest';
import { jobsPublishRoute } from './jobs-publish';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import * as jobsMapping from '../jobs-mapping';
import * as uploadsMapping from '../uploads-mapping';
import * as profiles from '@/server/asset-jobs/profiles';
import * as publishAssignments from '@/server/asset-jobs/publish-assignments';

// Same full-module-mock convention jobs-retry.test.ts uses: every I/O
// dependency jobs-publish.ts imports (job/upload reads, variant loading,
// assignment building, idempotency) is mocked at the module boundary. The
// only real ctx.supabase chain exercised here is the ONE query
// jobs-publish.ts issues directly (`.from('print_fulfilment_assets')...`)
// plus the `.rpc('publish_print_asset_revision', ...)` call — mirrored below
// with a dedicated chain-shaped stub, same pattern as jobs-retry.test.ts's
// `resetSupabase()` helper for its own single direct-write call.
vi.mock('../idempotency');
vi.mock('../jobs-mapping', () => ({ getJobRowById: vi.fn() }));
vi.mock('../uploads-mapping', () => ({ getUploadRowById: vi.fn() }));
vi.mock('@/server/asset-jobs/profiles', () => ({
  loadActivePrintVariants: vi.fn(),
  // Real implementation is `cms-${uploadId}` — kept faithful here (rather
  // than an opaque stub) so assertions on the RPC's p_revision argument mean
  // something.
  assetRevisionForUpload: vi.fn((uploadId: string) => `cms-${uploadId}`),
}));
vi.mock('@/server/asset-jobs/publish-assignments', () => ({ buildJobPublishAssignments: vi.fn() }));

const JOB_ID = '22222222-2222-2222-2222-222222222222';
const UPLOAD_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = 'product-1';
const REVISION = `cms-${UPLOAD_ID}`;

const completedJobRow = {
  id: JOB_ID,
  upload_id: UPLOAD_ID,
  asset_id: 'staged-asset-1',
  asset_revision: 1,
  status: 'completed' as const,
  attempts: 1,
  idempotency_key: `print-asset-job:${UPLOAD_ID}:v1`,
  last_error: null,
  created_at: '2026-09-17T12:00:00.000Z',
  updated_at: '2026-09-17T12:05:00.000Z',
};

const uploadRow = {
  id: UPLOAD_ID,
  filename: 'design.jpg',
  content_type: 'image/jpeg' as const,
  declared_byte_size: 1234,
  ratio: '3x4',
  product_id: PRODUCT_ID,
  r2_key: `uploads/${UPLOAD_ID}.jpg`,
  status: 'confirmed' as const,
  revision: 1,
  confirmed_byte_size: 1234,
  confirmed_content_type: 'image/jpeg',
  created_by: 'anna@studio.pl',
  created_at: '2026-09-17T11:00:00.000Z',
  expires_at: '2026-09-18T11:00:00.000Z',
  updated_at: '2026-09-17T11:05:00.000Z',
};

const variants = [{ variantKey: 'small:false:false:none', w: 60, h: 80 }];

const readyRows = [{ id: 'asset-1', profile_key: '60x80' }];

const assignmentsOk = {
  kind: 'ok' as const,
  assignments: [{ variant_key: 'small:false:false:none', asset_id: 'asset-1' }],
};

const publishResult = { productId: PRODUCT_ID, revision: REVISION, assignedCount: 1 };
// Shape of the row publish_print_asset_revision's RETURNS TABLE actually
// hands back (snake_case DB column names) — distinct from publishResult
// above, which is the handler's own camelCase wire mapping of it.
const rpcRow = { product_id: PRODUCT_ID, revision: REVISION, assigned_count: 1 };

function req(id: string, body: unknown, idempotencyKey: string | null = 'key-1'): Request {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request(`https://x.test/v1/jobs/${id}/publish`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctx(supabase: unknown = {}): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: supabase as never };
}

/**
 * Builds a `ctx.supabase` stub for exactly the two direct calls
 * jobs-publish.ts itself makes: the `.from('print_fulfilment_assets')
 * .select('id, profile_key').eq('product_id', ...).eq('revision', ...)
 * .eq('status', 'ready')` read, and `.rpc('publish_print_asset_revision', ...)`.
 * All other reads (job/upload/variants) go through the mocked mapping/profile
 * modules above, never through this stub.
 */
function publishSupabase(
  opts: {
    readyData?: { id: string; profile_key: string | null }[] | null;
    readyError?: unknown;
    rpcData?: unknown;
    rpcError?: unknown;
  } = {},
) {
  const { readyData = readyRows, readyError = null, rpcData = [rpcRow], rpcError = null } = opts;
  const eq3 = vi.fn().mockResolvedValue({ data: readyData, error: readyError });
  const eq2 = vi.fn().mockReturnValue({ eq: eq3 });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const from = vi.fn().mockReturnValue({ select });
  const rpc = vi.fn().mockResolvedValue({ data: rpcData, error: rpcError });
  return { supabase: { from, rpc } as never, from, select, eq1, eq2, eq3, rpc };
}

describe('jobsPublishRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-1' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(jobsMapping.getJobRowById).mockResolvedValue(completedJobRow as never);
    vi.mocked(uploadsMapping.getUploadRowById).mockResolvedValue(uploadRow as never);
    vi.mocked(profiles.loadActivePrintVariants).mockResolvedValue({ kind: 'ok', variants } as never);
    vi.mocked(publishAssignments.buildJobPublishAssignments).mockReturnValue(assignmentsOk);
  });

  it('404s a malformed (non-uuid) id before doing any other work', async () => {
    const res = await jobsPublishRoute.handler(req('not-a-uuid', { expectedRevision: 1 }), {} as never, { id: 'not-a-uuid' }, ctx());
    expect(res.status).toBe(404);
    expect(idempotency.claimIdempotencyKey).not.toHaveBeenCalled();
  });

  it('rejects a request with no Idempotency-Key', async () => {
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }, null), {} as never, { id: JOB_ID }, ctx());
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('rejects invalid JSON body', async () => {
    const badReq = new Request(`https://x.test/v1/jobs/${JOB_ID}/publish`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-1' },
      body: '{not-json',
    });
    const res = await jobsPublishRoute.handler(badReq, {} as never, { id: JOB_ID }, ctx());
    expect(res.status).toBe(422);
  });

  it('rejects a missing expectedRevision', async () => {
    const res = await jobsPublishRoute.handler(req(JOB_ID, {}), {} as never, { id: JOB_ID }, ctx());
    expect(res.status).toBe(422);
    const body = (await res.json()) as { fieldErrors?: Record<string, string> };
    expect(body.fieldErrors).toEqual({ expectedRevision: 'required' });
  });

  it('idempotency replay: returns the stored response and never touches the job table', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'replay', status: 200, body: publishResult });
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(publishResult);
    expect(jobsMapping.getJobRowById).not.toHaveBeenCalled();
  });

  it('409s when a request with this key is already in progress', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'in_progress' });
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx());
    expect(res.status).toBe(409);
  });

  it('422s on key reuse with a different body', async () => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'key_reuse' });
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx());
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('404s and releases the key when the job does not exist', async () => {
    vi.mocked(jobsMapping.getJobRowById).mockResolvedValue(null);
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx());
    expect(res.status).toBe(404);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('409s REVISION_CONFLICT and releases the key when expectedRevision does not match', async () => {
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 2 }), {} as never, { id: JOB_ID }, ctx());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; currentRevision: number };
    expect(body.code).toBe('REVISION_CONFLICT');
    expect(body.currentRevision).toBe(1);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('422s and releases the key when the job is not completed', async () => {
    vi.mocked(jobsMapping.getJobRowById).mockResolvedValue({ ...completedJobRow, status: 'processing' } as never);
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx());
    expect(res.status).toBe(422);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('404s and releases the key when the upload no longer exists', async () => {
    vi.mocked(uploadsMapping.getUploadRowById).mockResolvedValue(null);
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx());
    expect(res.status).toBe(404);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('422s and releases the key when loadActivePrintVariants reports invalid', async () => {
    vi.mocked(profiles.loadActivePrintVariants).mockResolvedValue({ kind: 'invalid', message: 'no active variants' });
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx());
    expect(res.status).toBe(422);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('500s and releases the key when the ready-assets read errors', async () => {
    const { supabase } = publishSupabase({ readyError: { message: 'db down' } });
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx(supabase));
    expect(res.status).toBe(500);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('builds the ready-asset map from profile_key rows and passes it to buildJobPublishAssignments', async () => {
    const { supabase } = publishSupabase();
    await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx(supabase));
    expect(publishAssignments.buildJobPublishAssignments).toHaveBeenCalledWith(variants, new Map([['60x80', 'asset-1']]));
  });

  it('422s MISSING_PROFILES and releases the key when assignments are incomplete', async () => {
    vi.mocked(publishAssignments.buildJobPublishAssignments).mockReturnValue({
      kind: 'missing_profiles',
      missingVariantKeys: ['large:false:false:none'],
    });
    const { supabase } = publishSupabase();
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx(supabase));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('MISSING_PROFILES');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('publishes a completed job whose product has full ready coverage (200), calling the RPC with the actor email and completing the idempotency key', async () => {
    const { supabase, rpc } = publishSupabase();
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx(supabase));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(publishResult);
    expect(rpc).toHaveBeenCalledWith('publish_print_asset_revision', {
      p_product_id: PRODUCT_ID,
      p_revision: REVISION,
      p_assignments: assignmentsOk.assignments,
      p_actor_email: 'anna@studio.pl',
    });
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalledWith(
      expect.anything(),
      'jobs:publish',
      'key-1',
      'lease-1',
      200,
      publishResult,
    );
    expect(idempotency.releaseIdempotencyKey).not.toHaveBeenCalled();
  });

  it('422s MISSING_PROFILES and releases the key when the RPC itself raises assignment_mismatch', async () => {
    // Real Supabase RPC errors are PostgrestError instances, which ARE
    // `instanceof Error` (verified against the installed @supabase/postgrest-js) —
    // jobs-publish.ts's catch block relies on that, so the mock must be a real
    // Error, not a plain { message } object.
    const { supabase } = publishSupabase({ rpcError: new Error('assignment_mismatch: missing=... ') });
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx(supabase));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('MISSING_PROFILES');
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });

  it('500s and releases the key when the RPC fails for an unrelated reason', async () => {
    const { supabase } = publishSupabase({ rpcError: new Error('connection reset') });
    const res = await jobsPublishRoute.handler(req(JOB_ID, { expectedRevision: 1 }), {} as never, { id: JOB_ID }, ctx(supabase));
    expect(res.status).toBe(500);
    expect(idempotency.releaseIdempotencyKey).toHaveBeenCalled();
  });
});
