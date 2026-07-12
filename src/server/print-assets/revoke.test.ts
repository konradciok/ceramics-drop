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

/** Wire assignment + variant tables for the two-query active-assignment check. */
function wireAssignmentMocks(
  from: ReturnType<typeof vi.fn>,
  assignments: { variant_key: string }[],
  variants: { variant_key: string; active: boolean }[],
) {
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
          eq: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: () => Promise.resolve({ data: { id: 'asset-1' }, error: null }),
              }),
            }),
          }),
        }),
      };
    }
    if (table === 'print_variant_asset_assignments') {
      const chain = makeChain({ data: assignments, error: null });
      chain.select = vi.fn().mockReturnValue(chain);
      return chain;
    }
    if (table === 'product_variants') {
      const chain = makeChain({ data: variants, error: null });
      chain.select = vi.fn().mockReturnValue(chain);
      return chain;
    }
    if (table === 'catalog_audit_log') {
      return { insert: vi.fn().mockResolvedValue({ error: null }) };
    }
    return makeChain({ data: null, error: null });
  });
}

describe('revokePrintAsset', () => {
  const from = vi.fn();
  const supabase = { from } as unknown as SupabaseClient;

  beforeEach(() => vi.clearAllMocks());

  it('revokes a ready asset that is not assigned to an active variant', async () => {
    const auditInsert = vi.fn().mockResolvedValue({ error: null });
    wireAssignmentMocks(from, [], []);
    from.mockImplementation((table: string) => {
      if (table === 'catalog_audit_log') return { insert: auditInsert };
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
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: { id: 'asset-1' }, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'print_variant_asset_assignments') {
        return makeChain({ data: [], error: null });
      }
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

  it('uses two queries for active assignments (no product_variants embed)', async () => {
    const assignmentSelect = vi.fn();
    const variantSelect = vi.fn();
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
        const chain = makeChain({ data: [{ variant_key: '50x70_unframed' }], error: null });
        chain.select = assignmentSelect.mockReturnValue(chain);
        return chain;
      }
      if (table === 'product_variants') {
        const chain = makeChain({
          data: [{ variant_key: '50x70_unframed', active: true }],
          error: null,
        });
        chain.select = variantSelect.mockReturnValue(chain);
        return chain;
      }
      return makeChain({ data: null, error: null });
    });

    const { revokePrintAsset } = await import('./revoke');
    expect(await revokePrintAsset(supabase, 'asset-1')).toEqual({
      ok: false,
      reason: 'still_assigned',
      assignedVariants: ['50x70_unframed'],
    });
    expect(assignmentSelect).toHaveBeenCalledWith('product_id, variant_key');
    expect(variantSelect).toHaveBeenCalledWith('variant_key, active');
    expect(assignmentSelect.mock.calls.some((c) => String(c[0]).includes('product_variants'))).toBe(
      false,
    );
  });

  it('blocks revoke when the asset is still assigned to an active variant', async () => {
    wireAssignmentMocks(
      from,
      [{ variant_key: '50x70_unframed' }],
      [{ variant_key: '50x70_unframed', active: true }],
    );

    const { revokePrintAsset } = await import('./revoke');
    expect(await revokePrintAsset(supabase, 'asset-1')).toEqual({
      ok: false,
      reason: 'still_assigned',
      assignedVariants: ['50x70_unframed'],
    });
  });

  it('allows revoke with force even when still assigned to an active variant', async () => {
    const auditInsert = vi.fn().mockResolvedValue({ error: null });
    wireAssignmentMocks(
      from,
      [{ variant_key: '50x70_unframed' }],
      [{ variant_key: '50x70_unframed', active: true }],
    );
    from.mockImplementation((table: string) => {
      if (table === 'catalog_audit_log') return { insert: auditInsert };
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
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: { id: 'asset-1' }, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'print_variant_asset_assignments') {
        return makeChain({ data: [{ variant_key: '50x70_unframed' }], error: null });
      }
      if (table === 'product_variants') {
        return makeChain({
          data: [{ variant_key: '50x70_unframed', active: true }],
          error: null,
        });
      }
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

  it('succeeds when audit insert fails (asset already revoked)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: { id: 'asset-1' }, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'print_variant_asset_assignments') {
        return makeChain({ data: [], error: null });
      }
      if (table === 'catalog_audit_log') {
        return { insert: vi.fn().mockResolvedValue({ error: { message: 'audit down' } }) };
      }
      return makeChain({ data: null, error: null });
    });

    const { revokePrintAsset } = await import('./revoke');
    expect(await revokePrintAsset(supabase, 'asset-1')).toEqual({ ok: true });
    expect(consoleSpy).toHaveBeenCalledWith(
      '[print-assets] revoke audit failed',
      'fap01',
      'audit down',
    );
    consoleSpy.mockRestore();
  });
});
