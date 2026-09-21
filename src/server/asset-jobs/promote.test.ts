import { describe, it, expect, vi } from 'vitest';
import { promoteStagedAssets } from './promote';

describe('promoteStagedAssets', () => {
  it('calls promote_print_assets_ready with the product, revision, and r2Keys, and returns the promotion results', async () => {
    const rpcResult = {
      data: [
        { r2_key: 'prints/p1/cms-u1/60x80-aaa.jpg', promoted: true },
        { r2_key: 'prints/p1/cms-u1/100x150-bbb.jpg', promoted: false },
      ],
      error: null,
    };
    const rpc = vi.fn(async (name: string, args: unknown) => {
      expect(name).toBe('promote_print_assets_ready');
      expect(args).toMatchObject({
        p_product_id: 'p1',
        p_revision: 'cms-u1',
        p_r2_keys: ['prints/p1/cms-u1/60x80-aaa.jpg', 'prints/p1/cms-u1/100x150-bbb.jpg'],
      });
      return rpcResult;
    });
    const supabase = { rpc } as never;

    const result = await promoteStagedAssets(supabase, {
      productId: 'p1',
      revision: 'cms-u1',
      r2Keys: ['prints/p1/cms-u1/60x80-aaa.jpg', 'prints/p1/cms-u1/100x150-bbb.jpg'],
    });

    expect(result.promoted).toEqual([
      { r2Key: 'prints/p1/cms-u1/60x80-aaa.jpg', promoted: true },
      { r2Key: 'prints/p1/cms-u1/100x150-bbb.jpg', promoted: false },
    ]);
  });

  it('throws when the RPC errors', async () => {
    const supabase = { rpc: vi.fn(async () => ({ data: null, error: new Error('promotion_state_changed') })) } as never;
    await expect(
      promoteStagedAssets(supabase, { productId: 'p1', revision: 'cms-u1', r2Keys: ['k1'] }),
    ).rejects.toThrow('promotion_state_changed');
  });

  it('is a no-op for an empty r2Keys list (never calls the RPC)', async () => {
    const rpc = vi.fn();
    const supabase = { rpc } as never;
    const result = await promoteStagedAssets(supabase, { productId: 'p1', revision: 'cms-u1', r2Keys: [] });
    expect(result.promoted).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});
