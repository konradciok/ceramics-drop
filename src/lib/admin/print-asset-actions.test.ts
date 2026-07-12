import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ revokePrintAsset: vi.fn() }));
vi.mock('@/server/print-assets/revoke', () => ({ revokePrintAsset: mocks.revokePrintAsset }));

import { revokePrintAssetAction } from './print-asset-actions';

describe('revokePrintAssetAction', () => {
  const supabase = {} as never;

  beforeEach(() => vi.clearAllMocks());

  it('maps a successful revoke to 200', async () => {
    mocks.revokePrintAsset.mockResolvedValue({ ok: true });
    const result = await revokePrintAssetAction(supabase, 'asset-1', {});
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ message: expect.stringContaining('asset-1') });
  });

  it('maps still_assigned to 409 with variant keys', async () => {
    mocks.revokePrintAsset.mockResolvedValue({
      ok: false,
      reason: 'still_assigned',
      assignedVariants: ['50x70_unframed'],
    });
    const result = await revokePrintAssetAction(supabase, 'asset-1', {});
    expect(result).toEqual({
      status: 409,
      body: { error: 'still_assigned', assignedVariants: ['50x70_unframed'] },
    });
  });
});
