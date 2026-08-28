import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registryPrintById } from '@/lib/prints';
import { GET, POST } from './route';

const mocks = vi.hoisted(() => ({
  loadPrintDesignsFromDb: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock('@/lib/catalog/load', () => ({
  loadPrintDesignsFromDb: mocks.loadPrintDesignsFromDb,
}));
vi.mock('next/cache', () => ({ revalidateTag: mocks.revalidateTag }));

describe('/api/admin/catalog-cache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hard-expires the catalog tag instead of serving stale-while-revalidate data', async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invalidated: true, tag: 'catalog' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.revalidateTag).toHaveBeenCalledWith('catalog', { expire: 0 });
  });

  it('returns a fail-closed response when the hard invalidation cannot be recorded', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.revalidateTag.mockImplementationOnce(() => {
      throw new Error('incremental cache unavailable');
    });

    const response = await POST();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'catalog_cache_invalidation_failed' });
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it('reads the tagged DB loader so operators can prove the first post-invalidation read is fresh', async () => {
    mocks.loadPrintDesignsFromDb.mockResolvedValue([
      registryPrintById('fap001'),
      registryPrintById('fap029'),
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      prints: [
        { id: 'fap001', num: '01', published: true },
        { id: 'fap029', num: '029', published: false },
      ],
    });
  });

  it('fails closed without leaking database detail when the fresh catalog read fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.loadPrintDesignsFromDb.mockRejectedValue(new Error('database host and secret detail'));

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'catalog_cache_read_failed' });
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});
