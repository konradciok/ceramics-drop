import { describe, expect, it, vi, beforeEach } from 'vitest';
import { jobsListRoute } from './jobs-list';
import type { HandlerContext } from '../router';
import * as jobsMapping from '../jobs-mapping';

vi.mock('../jobs-mapping', () => ({
  listJobRows: vi.fn(),
  mapJobRowToResponse: vi.fn(),
}));

function ctx(): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };
}

const ENV = {} as CloudflareEnv;

describe('jobsListRoute', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists every job row mapped to the wire shape', async () => {
    vi.mocked(jobsMapping.listJobRows).mockResolvedValue([{ id: 'job-1' } as never, { id: 'job-2' } as never]);
    vi.mocked(jobsMapping.mapJobRowToResponse).mockImplementation((row) => ({
      id: (row as { id: string }).id,
      assetId: 'upload-1',
      revision: 1,
      status: 'queued',
      progress: 0,
      error: '',
    }));

    const req = new Request('https://x.test/v1/jobs');
    const res = await jobsListRoute.handler(req, ENV, {}, ctx());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ id: 'job-1', status: 'queued' });
  });

  it('returns an empty items array when there are no jobs', async () => {
    vi.mocked(jobsMapping.listJobRows).mockResolvedValue([]);
    const req = new Request('https://x.test/v1/jobs');
    const res = await jobsListRoute.handler(req, ENV, {}, ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
  });
});
