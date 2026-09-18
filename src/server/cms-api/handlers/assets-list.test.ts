import { describe, expect, it, vi } from 'vitest';
import { assetsListRoute } from './assets-list';
import type { HandlerContext } from '../router';
import * as mapping from '../assets-mapping';

vi.mock('../assets-mapping');

function ctx(): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_1', supabase: {} as never };
}

describe('assetsListRoute', () => {
  it('wraps loadAssetList in {items}', async () => {
    vi.mocked(mapping.loadAssetList).mockResolvedValue([
      { id: 'a1', name: 'fap01 · r1', revision: 0, status: 'ready', ratio: '3:4', url: 'https://x/a1', usages: [], error: '' },
    ]);
    const res = await assetsListRoute.handler(new Request('https://x.test/v1/assets'), { PRINT_ASSET_TOKEN_SECRET: 's' } as CloudflareEnv, {}, ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('a1');
  });

  it('returns an empty list when there are no ready/retired assets', async () => {
    vi.mocked(mapping.loadAssetList).mockResolvedValue([]);
    const res = await assetsListRoute.handler(new Request('https://x.test/v1/assets'), { PRINT_ASSET_TOKEN_SECRET: 's' } as CloudflareEnv, {}, ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
  });
});
