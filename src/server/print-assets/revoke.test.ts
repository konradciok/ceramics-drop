import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn),
    finally: (fn: () => void) => Promise.resolve(result).finally(fn),
  };
  for (const m of ['eq', 'select', 'update', 'in']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  return chain;
}

describe('revokePrintAsset', () => {
  const from = vi.fn();
  const supabase = { from } as unknown as SupabaseClient;

  beforeEach(() => vi.clearAllMocks());

  it('revokes a ready asset that is not assigned to an active variant', async () => {
    const auditInsert = vi.fn().mockResolvedValue({ error: null });
    from.mockImplementation((table: string) => {
      if (table === 'print_fulfilment_assets') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: 'asset-1',
                    product_id: 'fap01',
                    status: 'ready',
                    revision: 'r1',
                  },
                  error: null,
                }),
            }),
          }),
          update: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      }
      if (table === 'print_variant_asset_assignments') {
        return makeChain({ data: [], error: null });
      }
      if (table === 'catalog_audit_log') return { insert: auditInsert };
      return makeChain({ data: null, error: null });
    });

    const { revokePrintAsset } = await import('./revoke');
    expect(await revokePrintAsset(supabase, 'asset-1', { actorEmail: 'ops@studio.pl' })).toEqual({
      ok: true,
    });
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'print_asset_revoke', product_id: 'fap01' }),
    );
  });

  it('blocks revoke when the asset is still assigned to an active variant', async () => {
    from.mockImplementation((table: string) => {
      if (table === 'print_fulfilment_assets') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: 'asset-1',
                    product_id: 'fap01',
                    status: 'ready',
                    revision: 'r1',
                  },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'print_variant_asset_assignments') {
        return makeChain({
          data: [{ variant_key: '50x70_unframed', product_variants: { active: true } }],
          error: null,
        });
      }
      return makeChain({ data: null, error: null });
    });

    const { revokePrintAsset } = await import('./revoke');
    expect(await revokePrintAsset(supabase, 'asset-1')).toEqual({
      ok: false,
      reason: 'still_assigned',
      assignedVariants: ['50x70_unframed'],
    });
  });

  it('allows revoke with force even when still assigned to an active variant', async () => {
    const auditInsert = vi.fn().mockResolvedValue({ error: null });
    from.mockImplementation((table: string) => {
      if (table === 'print_fulfilment_assets') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: 'asset-1',
                    product_id: 'fap01',
                    status: 'ready',
                    revision: 'r1',
                  },
                  error: null,
                }),
            }),
          }),
          update: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      }
      if (table === 'print_variant_asset_assignments') {
        return makeChain({
          data: [{ variant_key: '50x70_unframed', product_variants: { active: true } }],
          error: null,
        });
      }
      if (table === 'catalog_audit_log') return { insert: auditInsert };
      return makeChain({ data: null, error: null });
    });

    const { revokePrintAsset } = await import('./revoke');
    expect(await revokePrintAsset(supabase, 'asset-1', { force: true })).toEqual({ ok: true });
  });

  it('returns already_revoked when the asset is already revoked', async () => {
    from.mockImplementation((table: string) => {
      if (table === 'print_fulfilment_assets') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: 'asset-1',
                    product_id: 'fap01',
                    status: 'revoked',
                    revision: 'r1',
                  },
                  error: null,
                }),
            }),
          }),
        };
      }
      return makeChain({ data: null, error: null });
    });

    const { revokePrintAsset } = await import('./revoke');
    expect(await revokePrintAsset(supabase, 'asset-1')).toEqual({
      ok: false,
      reason: 'already_revoked',
    });
  });
});
