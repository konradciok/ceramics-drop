import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => ({
  adminSupabase: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock('@/lib/admin/clients', () => ({ adminSupabase: mocks.adminSupabase }));
vi.mock('next/cache', () => ({ revalidateTag: mocks.revalidateTag }));

function req(body: unknown) {
  return new Request('http://localhost/api/admin/toggle-showroom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

// existingIds: what the `products` table existence check should report as found.
function supabaseUpdating(
  returnedRows: Array<{ product_id: string }>,
  existingIds: string[] = ['k01', 'k02', 'k03'],
) {
  const select = vi.fn().mockResolvedValue({ data: returnedRows, error: null });
  const inFn = vi.fn(() => ({ select }));
  const update = vi.fn(() => ({ in: inFn }));

  const productsSelectIn = vi
    .fn()
    .mockResolvedValue({ data: existingIds.map((id) => ({ id })), error: null });
  const productsSelect = vi.fn(() => ({ in: productsSelectIn }));

  const from = vi.fn((table: string) => (table === 'products' ? { select: productsSelect } : { update }));
  return { from, update, inFn, select, productsSelectIn };
}

describe('POST /api/admin/toggle-showroom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds pieces to the showroom, stamping showroom_entered_at and an optional note', async () => {
    const supabase = supabaseUpdating([{ product_id: 'k01' }, { product_id: 'k02' }]);
    mocks.adminSupabase.mockReturnValue(supabase);

    const res = await POST(req({ productIds: ['k01', 'k02'], showroom: true, note: 'Fair booth' }));
    const body = (await res.json()) as { message: string; count: number };

    expect(res.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.message).toContain('2');
    expect(supabase.update).toHaveBeenCalledWith(
      expect.objectContaining({ showroom: true, showroom_note: 'Fair booth', showroom_entered_at: expect.any(String) }),
    );
    expect(supabase.inFn).toHaveBeenCalledWith('product_id', ['k01', 'k02']);
    expect(mocks.revalidateTag).toHaveBeenCalledWith('inventory', 'max');
  });

  it('accepts a DB-only product id absent from the static registry', async () => {
    const supabase = supabaseUpdating([{ product_id: 'prd_abc123' }], ['prd_abc123']);
    mocks.adminSupabase.mockReturnValue(supabase);

    const res = await POST(req({ productIds: ['prd_abc123'], showroom: true }));
    const body = (await res.json()) as { count: number };

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(supabase.productsSelectIn).toHaveBeenCalledWith('id', ['prd_abc123']);
  });

  it('removes pieces from the showroom, clearing showroom_entered_at and note', async () => {
    const supabase = supabaseUpdating([{ product_id: 'k01' }]);
    mocks.adminSupabase.mockReturnValue(supabase);

    const res = await POST(req({ productIds: ['k01'], showroom: false }));
    const body = (await res.json()) as { count: number };

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(supabase.update).toHaveBeenCalledWith({
      showroom: false,
      showroom_entered_at: null,
      showroom_note: null,
    });
  });

  it('rejects unknown product ids', async () => {
    mocks.adminSupabase.mockReturnValue(supabaseUpdating([], []));

    const res = await POST(req({ productIds: ['nope'], showroom: true }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain('nope');
  });

  it('requires a non-empty productIds array', async () => {
    const res = await POST(req({ productIds: [], showroom: true }));
    expect(res.status).toBe(400);
  });

  it('returns a Supabase error as a 500 when the existence check fails', async () => {
    const productsSelectIn = vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } });
    const productsSelect = vi.fn(() => ({ in: productsSelectIn }));
    mocks.adminSupabase.mockReturnValue({ from: vi.fn(() => ({ select: productsSelect })) });

    const res = await POST(req({ productIds: ['k01'], showroom: true }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe('db down');
  });

  it('returns a Supabase error as a 500 when the update fails', async () => {
    const select = vi.fn().mockResolvedValue({ data: null, error: { message: 'update failed' } });
    const inFn = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ in: inFn }));
    const productsSelectIn = vi.fn().mockResolvedValue({ data: [{ id: 'k01' }], error: null });
    const productsSelect = vi.fn(() => ({ in: productsSelectIn }));
    mocks.adminSupabase.mockReturnValue({
      from: vi.fn((table: string) => (table === 'products' ? { select: productsSelect } : { update })),
    });

    const res = await POST(req({ productIds: ['k01'], showroom: true }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe('update failed');
  });
});
