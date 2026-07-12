import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => ({
  adminSupabase: vi.fn(),
  revokePrintAssetAction: vi.fn(),
}));

vi.mock('@/lib/admin/clients', () => ({ adminSupabase: mocks.adminSupabase }));
vi.mock('@/lib/admin/print-asset-actions', () => ({
  revokePrintAssetAction: mocks.revokePrintAssetAction,
}));

function req(body: unknown) {
  return new Request('http://localhost/api/admin/revoke-print-asset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

describe('POST /api/admin/revoke-print-asset', () => {
  beforeEach(() => vi.clearAllMocks());

  it('revokes an asset → 200', async () => {
    mocks.adminSupabase.mockReturnValue({});
    mocks.revokePrintAssetAction.mockResolvedValue({
      status: 200,
      body: { message: 'Asset asset-1 revoked.' },
    });

    const res = await POST(req({ assetId: 'asset-1' }));
    expect(res.status).toBe(200);
    expect(mocks.revokePrintAssetAction).toHaveBeenCalledWith({}, 'asset-1', {
      force: false,
      actorEmail: null,
    });
  });

  it('rejects missing assetId → 400', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(mocks.revokePrintAssetAction).not.toHaveBeenCalled();
  });
});
