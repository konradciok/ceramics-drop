import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => ({ adminSupabase: vi.fn() }));
vi.mock('@/lib/admin/clients', () => ({ adminSupabase: mocks.adminSupabase }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
import { revalidateTag } from 'next/cache';

const ROW = { id: 'k01', type: 'ceramic', category_slug: 'kubki', status: 'active', price_pln: 95, published_at: null };

/** A Supabase double covering: before-read (select→eq→maybeSingle), update
 *  (update→eq→select→maybeSingle), and the audit insert. */
function supabase(opts: { before?: unknown; updated?: unknown; updateError?: { code?: string; message: string } } = {}) {
  const { before = ROW, updated = { ...ROW, price_pln: 120 }, updateError } = opts;
  const auditInsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) => {
    if (table === 'catalog_audit_log') return { insert: auditInsert };
    return {
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: before, error: null }) }) }),
      update: () => ({
        eq: () => ({
          select: () => ({
            maybeSingle: () =>
              Promise.resolve(updateError ? { data: null, error: updateError } : { data: updated, error: null }),
          }),
        }),
      }),
    };
  });
  return { supabase: { from }, auditInsert };
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/products/k01', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}
const ctx = (id = 'k01') => ({ params: Promise.resolve({ id }) }) as Parameters<typeof POST>[1];

describe('POST /api/admin/products/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates metadata, writes an audit row, revalidates the catalog → 200', async () => {
    const { supabase: sb, auditInsert } = supabase();
    mocks.adminSupabase.mockReturnValue(sb);

    const res = await POST(req({ price_pln: 120 }, { 'X-Admin-Actor-Email': 'anna@studio.pl' }), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).product.price_pln).toBe(120);
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ product_id: 'k01', actor_email: 'anna@studio.pl', action: 'update' }),
    );
    expect(revalidateTag).toHaveBeenCalledWith('catalog', 'max');
  });

  it('rejects an unknown field (strict Zod) → 400, before touching the DB', async () => {
    mocks.adminSupabase.mockReturnValue(supabase().supabase);
    const res = await POST(req({ price_eur: 25 }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_failed');
    expect(mocks.adminSupabase).not.toHaveBeenCalled();
  });

  it('unknown product id → 404 product_not_found', async () => {
    mocks.adminSupabase.mockReturnValue(supabase({ before: null }).supabase);
    const res = await POST(req({ price_pln: 120 }), ctx('zz99'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('product_not_found');
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('slug collision (unique violation) → 409 slug_taken', async () => {
    mocks.adminSupabase.mockReturnValue(supabase({ updateError: { code: '23505', message: 'duplicate key' } }).supabase);
    const res = await POST(req({ slug: 'kubek-lazur' }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('slug_taken');
  });

  it('other DB failure → 500', async () => {
    mocks.adminSupabase.mockReturnValue(supabase({ updateError: { message: 'connection reset' } }).supabase);
    const res = await POST(req({ price_pln: 120 }), ctx());
    expect(res.status).toBe(500);
  });
});
