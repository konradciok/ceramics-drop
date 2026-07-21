import { describe, it, expect } from 'vitest';
import { promoteVerifiedAssets } from './print-assets-promotion';

// The fake mirrors PromotionClient structurally (kept local so the adapter's
// interface stays private, exactly as shipped). It records every call so a test
// can assert the adapter forwards ALL requested keys in one RPC invocation.
type RpcArgs = {
  p_product_id: string;
  p_revision: string;
  p_r2_keys: string[];
  p_verified_at: string;
};
type RpcResponse = { data: unknown; error: { message: string } | null };

function fakeClient(response: RpcResponse) {
  const calls: Array<{ name: string; args: RpcArgs }> = [];
  const client = {
    rpc(name: 'promote_print_assets_ready', args: RpcArgs): Promise<RpcResponse> {
      calls.push({ name, args });
      return Promise.resolve(response);
    },
  };
  return { client, calls };
}

describe('promoteVerifiedAssets', () => {
  it('forwards every requested key (including already-ready rows) in a single RPC call', async () => {
    const r2Keys = [
      'prints/fap01/r1/3600x4800-a.jpg',
      'prints/fap01/r1/3600x4800-b.jpg', // observed already ready → promoted:false
      'prints/fap01/r1/3600x4800-c.jpg',
    ];
    const { client, calls } = fakeClient({
      data: [
        { r2_key: 'prints/fap01/r1/3600x4800-a.jpg', promoted: true },
        { r2_key: 'prints/fap01/r1/3600x4800-b.jpg', promoted: false },
        { r2_key: 'prints/fap01/r1/3600x4800-c.jpg', promoted: true },
      ],
      error: null,
    });

    const result = await promoteVerifiedAssets({
      client,
      productId: 'fap01',
      revision: 'r1',
      r2Keys,
      verifiedAt: '2026-07-21T12:00:00Z',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: 'promote_print_assets_ready',
      args: {
        p_product_id: 'fap01',
        p_revision: 'r1',
        p_r2_keys: r2Keys, // every key, including the already-ready one
        p_verified_at: '2026-07-21T12:00:00Z',
      },
    });
    expect(result).toEqual({ promotedCount: 2 });
  });

  it('counts only the rows this call promoted in a mixed response', async () => {
    const r2Keys = [
      'prints/fap01/r1/3600x4800-a.jpg',
      'prints/fap01/r1/3600x4800-b.jpg',
      'prints/fap01/r1/3600x4800-c.jpg',
    ];
    const { client } = fakeClient({
      data: [
        { r2_key: 'prints/fap01/r1/3600x4800-a.jpg', promoted: false },
        { r2_key: 'prints/fap01/r1/3600x4800-b.jpg', promoted: true },
        { r2_key: 'prints/fap01/r1/3600x4800-c.jpg', promoted: false },
      ],
      error: null,
    });

    const result = await promoteVerifiedAssets({
      client,
      productId: 'fap01',
      revision: 'r1',
      r2Keys,
    });

    expect(result).toEqual({ promotedCount: 1 });
  });

  it('propagates a promotion_state_changed RPC error', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'promotion_state_changed' } });

    await expect(
      promoteVerifiedAssets({
        client,
        productId: 'fap01',
        revision: 'r1',
        r2Keys: ['prints/fap01/r1/3600x4800-a.jpg'],
      }),
    ).rejects.toThrow(/Failed to promote verified assets transactionally: promotion_state_changed/);
  });

  it('treats a short successful response as an invariant failure', async () => {
    const r2Keys = ['prints/fap01/r1/3600x4800-a.jpg', 'prints/fap01/r1/3600x4800-b.jpg'];
    // The RPC is contracted to return one row per requested key; a short array
    // must never be read as a silent partial success.
    const { client } = fakeClient({
      data: [{ r2_key: 'prints/fap01/r1/3600x4800-a.jpg', promoted: true }],
      error: null,
    });

    await expect(
      promoteVerifiedAssets({ client, productId: 'fap01', revision: 'r1', r2Keys }),
    ).rejects.toThrow(/returned 1\/2 requested key/);
  });
});
