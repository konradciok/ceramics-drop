import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => ({ adminSupabase: vi.fn() }));
vi.mock('@/lib/admin/clients', () => ({ adminSupabase: mocks.adminSupabase }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/server/print-assets/repository', () => ({ getPrintAssetReadiness: vi.fn() }));
import { revalidateTag } from 'next/cache';
import { getPrintAssetReadiness } from '@/server/print-assets/repository';

const ROW = { id: 'k01', type: 'ceramic', category_slug: 'kubki', status: 'draft', published_at: null };
const PRINT_ROW = { id: 'fap01', type: 'print', category_slug: 'fine-art-prints', status: 'draft', published_at: null };

function supabase(opts: { before?: unknown } = {}) {
  const { before = ROW } = opts;
  const updateArgs: Record<string, unknown>[] = [];
  const auditInsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) => {
    if (table === 'catalog_audit_log') return { insert: auditInsert };
    return {
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: before, error: null }) }) }),
      update: (patch: Record<string, unknown>) => {
        updateArgs.push(patch);
        return {
          eq: () => ({
            select: () => ({ maybeSingle: () => Promise.resolve({ data: { ...(before as object), ...patch }, error: null }) }),
          }),
        };
      },
    };
  });
  return { supabase: { from }, auditInsert, updateArgs };
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/products/k01/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}
const ctx = (id = 'k01') => ({ params: Promise.resolve({ id }) }) as Parameters<typeof POST>[1];

describe('POST /api/admin/products/[id]/publish', () => {
  beforeEach(() => vi.clearAllMocks());

  it('activates a draft, stamps published_at, audits, revalidates → 200', async () => {
    const { supabase: sb, auditInsert, updateArgs } = supabase();
    mocks.adminSupabase.mockReturnValue(sb);

    const res = await POST(req({ status: 'active' }, { 'X-Admin-Actor-Email': 'anna@studio.pl' }), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).product.status).toBe('active');
    // First activation stamps published_at.
    expect(updateArgs[0]).toHaveProperty('published_at');
    expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({ action: 'status:active' }));
    expect(revalidateTag).toHaveBeenCalledWith('catalog', 'max');
  });

  it('does not re-stamp published_at when already published', async () => {
    const { supabase: sb, updateArgs } = supabase({ before: { ...ROW, status: 'active', published_at: '2026-01-01T00:00:00Z' } });
    mocks.adminSupabase.mockReturnValue(sb);

    await POST(req({ status: 'hidden' }), ctx());
    expect(updateArgs[0]).not.toHaveProperty('published_at');
  });

  it('rejects an invalid status → 400', async () => {
    const res = await POST(req({ status: 'sold' }), ctx());
    expect(res.status).toBe(400);
    expect(mocks.adminSupabase).not.toHaveBeenCalled();
  });

  it('unknown product id → 404', async () => {
    mocks.adminSupabase.mockReturnValue(supabase({ before: null }).supabase);
    const res = await POST(req({ status: 'active' }), ctx('zz99'));
    expect(res.status).toBe(404);
  });

  it('blocks print activation when fulfilment assets are incomplete → 409', async () => {
    vi.mocked(getPrintAssetReadiness).mockResolvedValue({
      productId: 'fap01',
      ready: false,
      totalActiveVariants: 2,
      missing: ['50x70_unframed'],
    });
    mocks.adminSupabase.mockReturnValue(supabase({ before: PRINT_ROW }).supabase);

    const res = await POST(req({ status: 'active' }), ctx('fap01'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'print_assets_incomplete',
      missing: ['50x70_unframed'],
    });
  });
});
