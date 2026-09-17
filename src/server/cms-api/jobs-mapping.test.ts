import { describe, expect, it, vi } from 'vitest';
import { getJobRowById, listJobRows, mapJobRowToResponse, requeueJobRow } from './jobs-mapping';
import type { PrintAssetJobRow } from '@/server/asset-jobs/enqueue';

const BASE_ROW: PrintAssetJobRow = {
  id: 'job-1',
  upload_id: 'upload-1',
  asset_id: null,
  asset_revision: 1,
  status: 'queued',
  attempts: 0,
  idempotency_key: 'print-asset-job:upload-1:v1',
  last_error: null,
  created_at: '2026-09-17T12:00:00.000Z',
  updated_at: '2026-09-17T12:00:00.000Z',
};

describe('mapJobRowToResponse', () => {
  it('maps a fresh queued row', () => {
    expect(mapJobRowToResponse(BASE_ROW)).toEqual({
      id: 'job-1',
      assetId: 'upload-1',
      revision: 1,
      status: 'queued',
      progress: 0,
      error: '',
    });
  });

  it('maps processing', () => {
    expect(mapJobRowToResponse({ ...BASE_ROW, status: 'processing' })).toMatchObject({ status: 'processing', progress: 0 });
  });

  it('maps completed to progress 100', () => {
    expect(mapJobRowToResponse({ ...BASE_ROW, status: 'completed' })).toMatchObject({ status: 'completed', progress: 100 });
  });

  it('maps failed_retryable and failed_action_required both to the wire "failed" status', () => {
    expect(mapJobRowToResponse({ ...BASE_ROW, status: 'failed_retryable', last_error: 'transient' })).toMatchObject({
      status: 'failed',
      error: 'transient',
    });
    expect(mapJobRowToResponse({ ...BASE_ROW, status: 'failed_action_required', last_error: 'permanent' })).toMatchObject({
      status: 'failed',
      error: 'permanent',
    });
  });

  it('reports an empty string, never null, when last_error is null', () => {
    expect(mapJobRowToResponse(BASE_ROW).error).toBe('');
  });
});

describe('listJobRows', () => {
  it('selects every row ordered by created_at desc', async () => {
    const order = vi.fn().mockResolvedValue({ data: [BASE_ROW], error: null });
    const select = vi.fn().mockReturnValue({ order });
    const supabase = { from: vi.fn().mockReturnValue({ select }) } as never;

    const rows = await listJobRows(supabase);
    expect(rows).toEqual([BASE_ROW]);
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('throws on a query error', async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    const supabase = { from: vi.fn().mockReturnValue({ select: () => ({ order }) }) } as never;
    await expect(listJobRows(supabase)).rejects.toBeTruthy();
  });
});

describe('getJobRowById', () => {
  it('returns null when no row matches', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = { from: vi.fn().mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) }) } as never;
    expect(await getJobRowById(supabase, 'missing')).toBeNull();
  });

  it('returns the row', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: BASE_ROW, error: null });
    const supabase = { from: vi.fn().mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) }) } as never;
    expect(await getJobRowById(supabase, 'job-1')).toEqual(BASE_ROW);
  });
});

describe('requeueJobRow', () => {
  it('CAS-updates status to queued only from a failed status, returns the updated row', async () => {
    const inFn = vi.fn().mockReturnValue({
      select: () => ({ maybeSingle: async () => ({ data: { ...BASE_ROW, status: 'queued' }, error: null }) }),
    });
    const eq = vi.fn().mockReturnValue({ in: inFn });
    const update = vi.fn().mockReturnValue({ eq });
    const supabase = { from: vi.fn().mockReturnValue({ update }) } as never;

    const row = await requeueJobRow(supabase, 'job-1');
    expect(row).toMatchObject({ status: 'queued' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }));
    expect(inFn).toHaveBeenCalledWith('status', ['failed_retryable', 'failed_action_required']);
  });

  it('returns null when the CAS matches no row (lost race / already advanced)', async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        update: () => ({ eq: () => ({ in: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
      }),
    } as never;
    expect(await requeueJobRow(supabase, 'job-1')).toBeNull();
  });

  it('throws on an update error', async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        update: () => ({ eq: () => ({ in: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }),
      }),
    } as never;
    await expect(requeueJobRow(supabase, 'job-1')).rejects.toBeTruthy();
  });
});
