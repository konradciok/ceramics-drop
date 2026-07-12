import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  getPrintAssetReadiness: vi.fn(),
}));
vi.mock('@/server/print-assets/repository', () => ({
  getPrintAssetReadiness: mocks.getPrintAssetReadiness,
}));

import { updateProductStatus } from './repository';

const PRINT_DRAFT = {
  id: 'fap01',
  type: 'print',
  category_slug: 'fine-art-prints',
  status: 'draft',
  published_at: null,
};

const CERAMIC_DRAFT = {
  id: 'k01',
  type: 'ceramic',
  category_slug: 'kubki',
  status: 'draft',
  published_at: null,
};

function supabaseForStatus(before: Record<string, unknown> | null) {
  const auditInsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) => {
    if (table === 'catalog_audit_log') return { insert: auditInsert };
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: before, error: null }),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: () => ({
          select: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: before ? { ...before, ...patch } : null,
                error: null,
              }),
          }),
        }),
      }),
    };
  });
  return { supabase: { from } as unknown as SupabaseClient, auditInsert };
}

describe('updateProductStatus publish guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks draft → active for a print when assets are incomplete', async () => {
    mocks.getPrintAssetReadiness.mockResolvedValue({
      productId: 'fap01',
      ready: false,
      totalActiveVariants: 2,
      missing: ['50x70_unframed', '70x100_framed_black'],
    });
    const { supabase } = supabaseForStatus(PRINT_DRAFT);

    await expect(
      updateProductStatus(supabase, 'fap01', 'active', 'ops@studio.pl'),
    ).rejects.toMatchObject({
      message: 'print_assets_incomplete',
      missing: ['50x70_unframed', '70x100_framed_black'],
    });
    expect(mocks.getPrintAssetReadiness).toHaveBeenCalledWith('fap01');
  });

  it('allows draft → active for a print when every active variant is covered', async () => {
    mocks.getPrintAssetReadiness.mockResolvedValue({
      productId: 'fap01',
      ready: true,
      totalActiveVariants: 21,
      missing: [],
    });
    const { supabase } = supabaseForStatus(PRINT_DRAFT);

    const row = await updateProductStatus(supabase, 'fap01', 'active', null);
    expect(row.status).toBe('active');
  });

  it('does not check readiness when activating a ceramic product', async () => {
    const { supabase } = supabaseForStatus(CERAMIC_DRAFT);

    const row = await updateProductStatus(supabase, 'k01', 'active', null);
    expect(row.status).toBe('active');
    expect(mocks.getPrintAssetReadiness).not.toHaveBeenCalled();
  });

  it('does not check readiness for print hidden → active when already active', async () => {
    mocks.getPrintAssetReadiness.mockClear();
    const { supabase } = supabaseForStatus({ ...PRINT_DRAFT, status: 'active', published_at: '2026-01-01' });

    await updateProductStatus(supabase, 'fap01', 'hidden', null);
    expect(mocks.getPrintAssetReadiness).not.toHaveBeenCalled();
  });

  it('checks readiness when hidden → active for a print', async () => {
    mocks.getPrintAssetReadiness.mockResolvedValue({
      productId: 'fap01',
      ready: true,
      totalActiveVariants: 1,
      missing: [],
    });
    const { supabase } = supabaseForStatus({ ...PRINT_DRAFT, status: 'hidden' });

    const row = await updateProductStatus(supabase, 'fap01', 'active', null);
    expect(row.status).toBe('active');
    expect(mocks.getPrintAssetReadiness).toHaveBeenCalledWith('fap01');
  });
});
