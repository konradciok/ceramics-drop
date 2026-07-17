import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { updateProductStatus } from './repository';

const PRINT_DRAFT = {
  id: 'fap01',
  type: 'print',
  category_slug: 'fine-art-prints',
  status: 'draft',
  published_at: null,
};

function supabaseForStatus(data: unknown, error: { message: string } | null = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { supabase: { rpc } as unknown as SupabaseClient, rpc };
}

describe('updateProductStatus guarded RPC', () => {
  it('maps an incomplete print response to PrintAssetsIncompleteError', async () => {
    const { supabase } = supabaseForStatus({
      ok: false,
      error: 'print_assets_incomplete',
      missing: ['50x70_unframed', '70x100_framed_black'],
    });

    await expect(
      updateProductStatus(supabase, 'fap01', 'active', 'ops@studio.pl'),
    ).rejects.toMatchObject({
      message: 'print_assets_incomplete',
      missing: ['50x70_unframed', '70x100_framed_black'],
    });
  });

  it('returns the atomically updated product and passes the actor', async () => {
    const product = {
      ...PRINT_DRAFT,
      status: 'active',
      published_at: '2026-07-17T12:00:00Z',
    };
    const { supabase, rpc } = supabaseForStatus({ ok: true, product });

    await expect(updateProductStatus(supabase, 'fap01', 'active', 'ops@studio.pl')).resolves.toBe(
      product,
    );
    expect(rpc).toHaveBeenCalledWith('update_product_status_guarded', {
      p_product_id: 'fap01',
      p_status: 'active',
      p_actor_email: 'ops@studio.pl',
    });
  });

  it('uses the same RPC for non-active and ceramic transitions', async () => {
    const ceramic = { ...PRINT_DRAFT, id: 'k01', type: 'ceramic', status: 'hidden' };
    const { supabase, rpc } = supabaseForStatus({ ok: true, product: ceramic });

    await updateProductStatus(supabase, 'k01', 'hidden', null);
    expect(rpc).toHaveBeenCalledWith('update_product_status_guarded', {
      p_product_id: 'k01',
      p_status: 'hidden',
      p_actor_email: null,
    });
  });

  it('normalises the RPC product-not-found error for the route mapper', async () => {
    const { supabase } = supabaseForStatus(null, { message: 'product_not_found' });

    await expect(updateProductStatus(supabase, 'missing', 'active', null)).rejects.toThrow(
      'product_not_found',
    );
  });

  it('fails closed on an empty RPC response', async () => {
    const { supabase } = supabaseForStatus(null);

    await expect(updateProductStatus(supabase, 'fap01', 'active', null)).rejects.toThrow(
      'empty RPC response',
    );
  });
});
