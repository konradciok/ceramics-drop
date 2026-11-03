import { describe, expect, it } from 'vitest';
import { readShippingRates } from './load';
import { DEFAULT_DOMESTIC_SHIPPING } from '../pricing';
import { DEFAULT_INTERNATIONAL_SHIPPING } from '../print-shipping';
import { buildShippingRateFields } from '@/server/cms-api/shipping-rates-mapping';
import type { Field } from '@/server/cms-api/types';

const RATES = { domestic: DEFAULT_DOMESTIC_SHIPPING, international: DEFAULT_INTERNATIONAL_SHIPPING };

type DraftKey = `${string}:${number}`;

/**
 * Minimal stand-in for the two tables' read chains:
 *   shipping_rates:       .select().in('id', ids).abortSignal()      -> rows
 *   shipping_rate_drafts: .select().eq().eq().abortSignal().maybeSingle() -> row
 */
function makeSupabase(
  rows: { id: string; published_revision: number | null }[] | null,
  drafts: Partial<Record<DraftKey, { fields: Field[] }>>,
  errors: { rows?: string; drafts?: string } = {},
) {
  return {
    from(table: string) {
      if (table === 'shipping_rates') {
        const builder = {
          select: () => builder,
          in: () => builder,
          abortSignal: async () => ({ data: rows, error: errors.rows ? { message: errors.rows } : null }),
        };
        return builder;
      }
      if (table === 'shipping_rate_drafts') {
        const filters: Record<string, unknown> = {};
        const builder = {
          select: () => builder,
          eq: (col: string, value: unknown) => {
            filters[col] = value;
            return builder;
          },
          abortSignal: () => builder,
          maybeSingle: async () => {
            if (errors.drafts) return { data: null, error: { message: errors.drafts } };
            const payload = drafts[`${String(filters.rate_id)}:${Number(filters.revision)}` as DraftKey];
            return { data: payload ? { payload } : null, error: null };
          },
        };
        return builder;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as never;
}

const publishedRows = [
  { id: 'domestic', published_revision: 1 },
  { id: 'international', published_revision: 1 },
];

const publishedDrafts: Partial<Record<DraftKey, { fields: Field[] }>> = {
  'domestic:1': { fields: buildShippingRateFields('domestic', RATES) },
  'international:1': { fields: buildShippingRateFields('international', RATES) },
};

describe('readShippingRates', () => {
  it('reconstructs both live rate tables from each resource\'s PUBLISHED revision', async () => {
    const rates = await readShippingRates(makeSupabase(publishedRows, publishedDrafts));
    expect(rates.domestic).toEqual(DEFAULT_DOMESTIC_SHIPPING);
    expect(rates.international).toEqual(DEFAULT_INTERNATIONAL_SHIPPING);
  });

  it('reads the PUBLISHED revision, never simply the newest draft', async () => {
    // Revision 2 exists and holds different numbers, but published_revision
    // still points at 1 — restoring or saving a draft must not move checkout.
    const raised = buildShippingRateFields('domestic', RATES).map((f) =>
      f.key === 'kurier_pln' ? { ...f, value: '99' } : f,
    );
    const rates = await readShippingRates(
      makeSupabase(publishedRows, { ...publishedDrafts, 'domestic:2': { fields: raised } }),
    );
    expect(rates.domestic.pln.kurier).toBe(30);
  });

  it('throws when a resource row is missing', async () => {
    await expect(
      readShippingRates(makeSupabase([{ id: 'domestic', published_revision: 1 }], publishedDrafts)),
    ).rejects.toThrow(/international/);
  });

  it('throws when a resource has never been published', async () => {
    await expect(
      readShippingRates(
        makeSupabase([{ id: 'domestic', published_revision: null }, { id: 'international', published_revision: 1 }], publishedDrafts),
      ),
    ).rejects.toThrow(/domestic/);
  });

  it('throws when the published draft row has vanished', async () => {
    await expect(
      readShippingRates(makeSupabase(publishedRows, { 'domestic:1': publishedDrafts['domestic:1'] })),
    ).rejects.toThrow(/international/);
  });

  it('throws — rather than charging a nonsense amount — when a published payload no longer parses', async () => {
    const corrupt = buildShippingRateFields('domestic', RATES).map((f) =>
      f.key === 'kurier_pln' ? { ...f, value: 'oops' } : f,
    );
    await expect(
      readShippingRates(makeSupabase(publishedRows, { ...publishedDrafts, 'domestic:1': { fields: corrupt } })),
    ).rejects.toThrow(/kurier_pln/);
  });

  it('propagates a Supabase error on the rows read', async () => {
    await expect(readShippingRates(makeSupabase(null, {}, { rows: 'boom' }))).rejects.toThrow(/boom/);
  });

  it('propagates a Supabase error on the draft read', async () => {
    await expect(readShippingRates(makeSupabase(publishedRows, {}, { drafts: 'boom' }))).rejects.toThrow(/boom/);
  });
});
