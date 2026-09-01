import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPrintPricingConfig, updatePrintPricingConfig } from './repository';

const ROW = {
  id: true,
  base_30x40_eur: 25,
  base_50x70_eur: 50,
  base_70x100_eur: 75,
  frame_30x40_eur: 35,
  frame_50x70_eur: 35,
  frame_70x100_eur: 35,
  mount_30x40_eur: 25,
  mount_50x70_eur: 25,
  mount_70x100_eur: 25,
  // numeric columns can arrive as strings — the repository must coerce them
  eur_to_pln: '4.25',
  eur_to_gbp: 0.86,
  updated_at: '2026-08-07T00:00:00Z',
  updated_by: null,
};

const NESTED = {
  baseEur: { '30x40': 25, '50x70': 50, '70x100': 75 },
  frameEur: { '30x40': 35, '50x70': 35, '70x100': 35 },
  mountEur: { '30x40': 25, '50x70': 25, '70x100': 25 },
  eurToPln: 4.25,
  eurToGbp: 0.86,
};

const selectMaybeSingle = vi.fn();
const updateMaybeSingle = vi.fn();
const updatePatch = vi.fn();
const updateEq = vi.fn();
const auditInsert = vi.fn();

function mockSupabase(): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === 'print_pricing_config') {
        // readPrintPricingConfig chains .abortSignal() before .maybeSingle();
        // updatePrintPricingConfig's own `before` read does not (write path,
        // out of scope for the timeout fix) — support both shapes.
        return {
          select: () => ({
            maybeSingle: selectMaybeSingle,
            abortSignal: () => ({ maybeSingle: selectMaybeSingle }),
          }),
          update: (patch: unknown) => {
            updatePatch(patch);
            return {
              eq: (col: string, val: unknown) => {
                updateEq(col, val);
                return { select: () => ({ maybeSingle: updateMaybeSingle }) };
              },
            };
          },
        };
      }
      if (table === 'catalog_audit_log') return { insert: auditInsert };
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectMaybeSingle.mockResolvedValue({ data: ROW, error: null });
  updateMaybeSingle.mockResolvedValue({ data: ROW, error: null });
  auditInsert.mockResolvedValue({ error: null });
});

describe('readPrintPricingConfig', () => {
  it('maps the flat row to the nested config, coercing numeric-as-string rates', async () => {
    await expect(readPrintPricingConfig(mockSupabase())).resolves.toEqual(NESTED);
  });

  it('throws print_pricing_missing when the seed row is absent', async () => {
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(readPrintPricingConfig(mockSupabase())).rejects.toThrow('print_pricing_missing');
  });

  it('throws on a Supabase error', async () => {
    selectMaybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(readPrintPricingConfig(mockSupabase())).rejects.toThrow('read print pricing: boom');
  });
});

describe('updatePrintPricingConfig', () => {
  it('updates the single row, stamps updated_by, and writes the audit row', async () => {
    const result = await updatePrintPricingConfig(mockSupabase(), NESTED, 'anna@studio.pl');
    expect(result).toEqual(NESTED);

    expect(updateEq).toHaveBeenCalledWith('id', true);
    const patch = updatePatch.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.base_50x70_eur).toBe(50);
    expect(patch.eur_to_pln).toBe(4.25);
    expect(patch.updated_by).toBe('anna@studio.pl');
    expect(typeof patch.updated_at).toBe('string');

    const audit = auditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.product_id).toBe('print-pricing');
    expect(audit.action).toBe('pricing:update');
    expect(audit.actor_email).toBe('anna@studio.pl');
    expect(audit.before).toEqual(ROW);
    expect(audit.after).toEqual(ROW);
  });

  it('throws print_pricing_missing when the row is absent (migration not applied)', async () => {
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(updatePrintPricingConfig(mockSupabase(), NESTED, null)).rejects.toThrow(
      'print_pricing_missing',
    );
    expect(updatePatch).not.toHaveBeenCalled();
  });

  it('treats an audit failure as non-fatal (the write already committed)', async () => {
    auditInsert.mockResolvedValue({ error: { message: 'audit down' } });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(updatePrintPricingConfig(mockSupabase(), NESTED, null)).resolves.toEqual(NESTED);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
