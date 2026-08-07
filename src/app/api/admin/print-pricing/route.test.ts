import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRINT_PRICING } from '@/lib/print-pricing';
import { POST } from './route';

const mocks = vi.hoisted(() => ({ adminSupabase: vi.fn() }));
vi.mock('@/lib/admin/clients', () => ({ adminSupabase: mocks.adminSupabase }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
import { revalidatePath, revalidateTag } from 'next/cache';

const ROW = {
  id: true,
  base_30x40_eur: 25, base_50x70_eur: 50, base_70x100_eur: 75,
  frame_30x40_eur: 35, frame_50x70_eur: 35, frame_70x100_eur: 35,
  mount_30x40_eur: 25, mount_50x70_eur: 25, mount_70x100_eur: 25,
  eur_to_pln: 4.25, eur_to_gbp: 0.86,
  updated_at: '2026-08-07T00:00:00Z', updated_by: null,
};

/** A Supabase double covering: before-read (select→maybeSingle), update
 *  (update→eq→select→maybeSingle), and the audit insert. */
function supabase(opts: { before?: unknown; updated?: unknown; updateError?: { message: string } } = {}) {
  const { before = ROW, updated = { ...ROW, base_50x70_eur: 60 }, updateError } = opts;
  const auditInsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) => {
    if (table === 'catalog_audit_log') return { insert: auditInsert };
    return {
      select: () => ({ maybeSingle: () => Promise.resolve({ data: before, error: null }) }),
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
  return new Request('http://localhost/api/admin/print-pricing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const VALID = { ...DEFAULT_PRINT_PRICING, baseEur: { ...DEFAULT_PRINT_PRICING.baseEur, '50x70': 60 } };

describe('POST /api/admin/print-pricing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves the config, writes an audit row, revalidates catalog + feeds → 200', async () => {
    const { supabase: sb, auditInsert } = supabase();
    mocks.adminSupabase.mockReturnValue(sb);

    const res = await POST(req(VALID, { 'X-Admin-Actor-Email': 'anna@studio.pl' }));

    expect(res.status).toBe(200);
    expect((await res.json()).config.baseEur['50x70']).toBe(60);
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ product_id: 'print-pricing', actor_email: 'anna@studio.pl', action: 'pricing:update' }),
    );
    expect(revalidateTag).toHaveBeenCalledWith('catalog', 'max');
    expect(revalidatePath).toHaveBeenCalledWith('/api/feed/google');
    expect(revalidatePath).toHaveBeenCalledWith('/api/feed/meta');
  });

  it.each([
    ['negative surcharge', { ...VALID, frameEur: { ...VALID.frameEur, '30x40': -1 } }],
    ['fractional price', { ...VALID, baseEur: { ...VALID.baseEur, '30x40': 24.5 } }],
    ['zero base', { ...VALID, baseEur: { ...VALID.baseEur, '70x100': 0 } }],
    ['zero rate', { ...VALID, eurToPln: 0 }],
    ['unknown key (strict)', { ...VALID, extra: 1 }],
    ['NaN from an empty form field', { ...VALID, eurToGbp: null }],
  ])('rejects %s → 400 validation_failed with field errors, before touching the DB', async (_name, body) => {
    mocks.adminSupabase.mockReturnValue(supabase().supabase);
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('validation_failed');
    expect(json.fields).toBeDefined();
    expect(mocks.adminSupabase).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('missing seed row (migration not applied) → 404 print_pricing_missing', async () => {
    mocks.adminSupabase.mockReturnValue(supabase({ before: null }).supabase);
    const res = await POST(req(VALID));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('print_pricing_missing');
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('DB failure → 500 pricing_write_failed without leaking detail', async () => {
    mocks.adminSupabase.mockReturnValue(supabase({ updateError: { message: 'connection reset' } }).supabase);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(req(VALID));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('pricing_write_failed');
    errSpy.mockRestore();
  });
});
