import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => ({
  adminSupabase: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock('@/lib/admin/clients', () => ({ adminSupabase: mocks.adminSupabase }));
vi.mock('next/cache', () => ({ revalidateTag: mocks.revalidateTag }));
vi.mock('@/lib/products', () => ({
  registryProductById: (id: string) => (['k01', 'k02', 'k03'].includes(id) ? { id } : undefined),
}));

function req(body: unknown) {
  return new Request('http://localhost/api/admin/set-piece-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

function supabaseUpdating(returnedRows: Array<{ product_id: string }>) {
  const select = vi.fn().mockResolvedValue({ data: returnedRows, error: null });
  const is = vi.fn(() => ({ select }));
  const eq = vi.fn(() => ({ select, is }));
  const inFn = vi.fn(() => ({ eq }));
  const update = vi.fn(() => ({ in: inFn }));
  const from = vi.fn(() => ({ update }));
  return { from, update, inFn, eq, is, select };
}

describe('POST /api/admin/set-piece-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks available pieces as sold, filtering the update to status=available', async () => {
    const supabase = supabaseUpdating([{ product_id: 'k01' }, { product_id: 'k02' }]);
    mocks.adminSupabase.mockReturnValue(supabase);

    const res = await POST(req({ productIds: ['k01', 'k02'], sold: true }));
    const body = (await res.json()) as { message: string; count: number };

    expect(res.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.message).toContain('2');
    expect(supabase.update).toHaveBeenCalledWith({ status: 'sold' });
    expect(supabase.inFn).toHaveBeenCalledWith('product_id', ['k01', 'k02']);
    expect(supabase.eq).toHaveBeenCalledWith('status', 'available');
    expect(mocks.revalidateTag).toHaveBeenCalledWith('inventory', 'max');
  });

  it('reports a partial match when some requested pieces are not eligible', async () => {
    // Only k01 was actually 'available'; k02 (e.g. reserved/already sold) is silently excluded by the DB filter.
    const supabase = supabaseUpdating([{ product_id: 'k01' }]);
    mocks.adminSupabase.mockReturnValue(supabase);

    const res = await POST(req({ productIds: ['k01', 'k02'], sold: true }));
    const body = (await res.json()) as { count: number };

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
  });

  it('reverts a manually-sold piece to available, filtering to status=sold and order_id IS NULL', async () => {
    const supabase = supabaseUpdating([{ product_id: 'k01' }]);
    mocks.adminSupabase.mockReturnValue(supabase);

    const res = await POST(req({ productIds: ['k01'], sold: false }));
    const body = (await res.json()) as { count: number };

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(supabase.update).toHaveBeenCalledWith({ status: 'available' });
    expect(supabase.eq).toHaveBeenCalledWith('status', 'sold');
    expect(supabase.is).toHaveBeenCalledWith('order_id', null);
  });

  it('rejects unknown product ids', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseUpdating([]));

    const res = await POST(req({ productIds: ['nope'], sold: true }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain('nope');
    expect(mocks.adminSupabase).not.toHaveBeenCalled();
  });

  it('requires a non-empty productIds array', async () => {
    const res = await POST(req({ productIds: [], sold: true }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing or non-boolean sold value instead of defaulting to false', async () => {
    const res = await POST(req({ productIds: ['k01'] }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain('boolean');
    expect(mocks.adminSupabase).not.toHaveBeenCalled();
  });

  it('returns a Supabase error as a 500', async () => {
    const select = vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } });
    const eq = vi.fn(() => ({ select, is: vi.fn(() => ({ select })) }));
    const inFn = vi.fn(() => ({ eq }));
    const update = vi.fn(() => ({ in: inFn }));
    mocks.adminSupabase.mockReturnValue({ from: vi.fn(() => ({ update })) });

    const res = await POST(req({ productIds: ['k01'], sold: true }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe('db down');
  });
});
