import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DOMESTIC_FIELD_DEFS,
  INTERNATIONAL_FIELD_DEFS,
  SHIPPING_RATE_FIELD_DEFS,
  SHIPPING_RATE_IDS,
  SHIPPING_RATE_NAMES,
  buildShippingRateFields,
  isShippingRateId,
  loadAllShippingRateResources,
  loadShippingRateResource,
  shippingRateFieldKeys,
  shippingRateFieldValues,
} from './shipping-rates-mapping';
import { DEFAULT_DOMESTIC_SHIPPING } from '@/lib/pricing';
import { DEFAULT_INTERNATIONAL_SHIPPING, PRINT_COUNTRIES } from '@/lib/print-shipping';
import type { Field } from './types';

describe('SHIPPING_RATE_IDS', () => {
  it('is exactly the two fulfilment tracks the plan names', () => {
    expect(SHIPPING_RATE_IDS).toEqual(['domestic', 'international']);
  });

  it('isShippingRateId narrows only those two', () => {
    expect(isShippingRateId('domestic')).toBe(true);
    expect(isShippingRateId('international')).toBe(true);
    expect(isShippingRateId('shipping-europe')).toBe(false);
    expect(isShippingRateId('')).toBe(false);
  });

  it('names both resources', () => {
    expect(SHIPPING_RATE_NAMES.domestic.length).toBeGreaterThan(0);
    expect(SHIPPING_RATE_NAMES.international.length).toBeGreaterThan(0);
  });
});

describe('DOMESTIC_FIELD_DEFS', () => {
  it('describes exactly 9 fields (3 methods x 3 currencies)', () => {
    expect(DOMESTIC_FIELD_DEFS).toHaveLength(9);
  });

  it('keys are <method>_<currency>, grouped currency-major like the three source constants', () => {
    expect(DOMESTIC_FIELD_DEFS.map((d) => d.key)).toEqual([
      'paczkomat_pln', 'kurier_pln', 'odbior_pln',
      'paczkomat_eur', 'kurier_eur', 'odbior_eur',
      'paczkomat_gbp', 'kurier_gbp', 'odbior_gbp',
    ]);
  });
});

describe('INTERNATIONAL_FIELD_DEFS', () => {
  it('describes exactly 56 fields (28 countries x 2 package types)', () => {
    expect(INTERNATIONAL_FIELD_DEFS).toHaveLength(56);
    expect(PRINT_COUNTRIES).toHaveLength(28);
  });

  it('keys are <cc>_<framed|loose>_eur in PRINT_COUNTRIES order, framed before loose', () => {
    expect(INTERNATIONAL_FIELD_DEFS.slice(0, 4).map((d) => d.key)).toEqual([
      'at_framed_eur', 'at_loose_eur', 'be_framed_eur', 'be_loose_eur',
    ]);
    expect(INTERNATIONAL_FIELD_DEFS.at(-1)?.key).toBe('gb_loose_eur');
  });

  it('has 56 distinct keys', () => {
    expect(new Set(INTERNATIONAL_FIELD_DEFS.map((d) => d.key)).size).toBe(56);
  });
});

describe('shippingRateFieldKeys', () => {
  it('returns each resource\'s own key list', () => {
    expect(shippingRateFieldKeys('domestic')).toEqual(DOMESTIC_FIELD_DEFS.map((d) => d.key));
    expect(shippingRateFieldKeys('international')).toEqual(INTERNATIONAL_FIELD_DEFS.map((d) => d.key));
  });

  it('keeps the two key spaces disjoint', () => {
    const domestic = new Set(shippingRateFieldKeys('domestic'));
    expect(shippingRateFieldKeys('international').some((k) => domestic.has(k))).toBe(false);
  });

  it('SHIPPING_RATE_FIELD_DEFS indexes both resources', () => {
    expect(SHIPPING_RATE_FIELD_DEFS.domestic).toBe(DOMESTIC_FIELD_DEFS);
    expect(SHIPPING_RATE_FIELD_DEFS.international).toBe(INTERNATIONAL_FIELD_DEFS);
  });
});

describe('buildShippingRateFields', () => {
  it('serialises the domestic constants as number/none fields in def order', () => {
    const fields = buildShippingRateFields('domestic', {
      domestic: DEFAULT_DOMESTIC_SHIPPING,
      international: DEFAULT_INTERNATIONAL_SHIPPING,
    });
    expect(fields).toHaveLength(9);
    for (const field of fields) {
      expect(field.type).toBe('number');
      expect(field.locale).toBe('none');
      expect(field.sourceLocale).toBe('none');
    }
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f.value]));
    expect(byKey.paczkomat_pln).toBe('20');
    expect(byKey.kurier_pln).toBe('30');
    expect(byKey.odbior_pln).toBe('0');
    expect(byKey.kurier_eur).toBe('10');
    expect(byKey.kurier_gbp).toBe('12');
  });

  it('serialises the international constants, keeping the 2-decimal Prodigi quotes exact', () => {
    const fields = buildShippingRateFields('international', {
      domestic: DEFAULT_DOMESTIC_SHIPPING,
      international: DEFAULT_INTERNATIONAL_SHIPPING,
    });
    expect(fields).toHaveLength(56);
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f.value]));
    expect(byKey.at_framed_eur).toBe('17.25');
    expect(byKey.at_loose_eur).toBe('10.45');
    expect(byKey.cy_framed_eur).toBe('132.43');
    expect(byKey.gb_loose_eur).toBe('5.66');
    expect(byKey.de_loose_eur).toBe('7.3');
  });
});

describe('shippingRateFieldValues', () => {
  const f = (key: string, value: string): Field => ({ key, label: key, type: 'number', value, locale: 'none', sourceLocale: 'none' });

  it('maps key -> value', () => {
    expect(shippingRateFieldValues([f('kurier_pln', '30')])).toEqual({ kurier_pln: '30' });
  });

  it('resolves duplicates to the LAST occurrence, matching the RPC jsonb_object_agg', () => {
    expect(shippingRateFieldValues([f('kurier_pln', '30'), f('kurier_pln', '35')])).toEqual({ kurier_pln: '35' });
  });

  it('returns an empty map for an empty field list', () => {
    expect(shippingRateFieldValues([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The day-one agreement guard. The migration's one-time backfill seeds
// shipping_rate_drafts revision 1 for BOTH resources from the very constants
// checkout charges today and stamps published_revision = 1 — so the Field
// keys/labels/VALUES it writes MUST be the ones this module builds, or the CMS
// would show a form that disagrees with the money being charged. Docker is
// unreachable in this environment (the migration cannot be run), so this static
// parse is the strongest available check that the two sides agree. Same guard
// style as pricing-mapping.test.ts and
// src/lib/print-pricing-config/migration-lockstep.test.ts.
// ---------------------------------------------------------------------------
describe('20260917150000_cms_api_shipping_rates.sql backfill lockstep', () => {
  const sql = readFileSync(
    join(__dirname, '../../../supabase/migrations/20260917150000_cms_api_shipping_rates.sql'),
    'utf8',
  );

  function valuesBlock(cteName: string): string {
    const match = sql.match(new RegExp(`${cteName}\\([^)]*\\) as \\(values([\\s\\S]*?)\\n\\)`));
    expect(match, `${cteName} VALUES block not found`).not.toBeNull();
    return match![1];
  }

  const expectedRates = { domestic: DEFAULT_DOMESTIC_SHIPPING, international: DEFAULT_INTERNATIONAL_SHIPPING };

  it('seeds the domestic resource with exactly this module\'s 9 keys, labels and values', () => {
    const rows = [...valuesBlock('domestic_seed').matchAll(/\('([^']*)',\s*'([^']*)',\s*'([^']*)',\s*(\d+)\)/g)];
    expect(rows).toHaveLength(9);
    // Ordinals must be 1..9 in file order, since jsonb_agg orders by them.
    expect(rows.map((r) => Number(r[4]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rows.map((r) => ({ key: r[1], label: r[2], value: r[3] }))).toEqual(
      buildShippingRateFields('domestic', expectedRates).map((f) => ({ key: f.key, label: f.label, value: f.value })),
    );
  });

  it('seeds the international resource from a 28-row table matching SHIPPING_EUR exactly', () => {
    const rows = [...valuesBlock('intl_seed').matchAll(/\('([A-Z]{2})',\s*'([^']*)',\s*'([^']*)',\s*(\d+)\)/g)];
    expect(rows).toHaveLength(28);
    expect(rows.map((r) => r[1])).toEqual([...PRINT_COUNTRIES]);
    expect(rows.map((r) => Number(r[4]))).toEqual(PRINT_COUNTRIES.map((_c, i) => i + 1));

    // The migration expands each row into two fields ({framed, loose}); rebuild
    // that expansion and compare against this module's 56 fields key-for-key.
    const seeded = rows.flatMap((r) => [
      { key: `${r[1].toLowerCase()}_framed_eur`, value: r[2] },
      { key: `${r[1].toLowerCase()}_loose_eur`, value: r[3] },
    ]);
    expect(seeded).toEqual(
      buildShippingRateFields('international', expectedRates).map((f) => ({ key: f.key, value: f.value })),
    );
  });

  it('declares the same canonical key lists in shipping_rate_field_keys()', () => {
    const domesticArray = sql.match(/when 'domestic' then array\[([\s\S]*?)\]/);
    expect(domesticArray).not.toBeNull();
    const keys = [...domesticArray![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(keys).toEqual(shippingRateFieldKeys('domestic'));

    // The international list is generated in SQL from the same 28 country codes.
    const countryArray = sql.match(/select array_agg\(lower\(c\.code\)[\s\S]*?unnest\(array\[([\s\S]*?)\]\)/);
    expect(countryArray).not.toBeNull();
    const codes = [...countryArray![1].matchAll(/'([A-Z]{2})'/g)].map((m) => m[1]);
    expect(codes).toEqual([...PRINT_COUNTRIES]);
  });

  it('creates both rows and stamps published_revision = 1 in the same migration', () => {
    expect(sql).toMatch(/insert into shipping_rates \(id\) values \('domestic'\), \('international'\);/);
    expect(sql).toMatch(/update shipping_rates r set published_revision = 1, published_at = now\(\);/);
  });

  it('never introduces a second FX-rate source (the plan\'s named correctness hazard)', () => {
    // Comments are stripped first: the file's header discusses the FX rates at
    // length precisely to explain why no column, key or cached copy of them
    // exists here. It is the executable SQL that must be free of them.
    const executable = sql.replace(/--[^\n]*/g, '');
    expect(executable).not.toMatch(/eur_to_pln|eur_to_gbp|eurToPln|eurToGbp/);
  });
});

// ---------------------------------------------------------------------------
// loadShippingRateResource — thin I/O over ctx.supabase. Never adminSupabase() /
// getCloudflareContext() (see the Task 5 regression in request-handler.test.ts).
// ---------------------------------------------------------------------------
function makeSupabase(rows: Record<string, unknown>, drafts: Record<string, unknown>) {
  return {
    from(table: string) {
      let rateId = '';
      const builder = {
        select: () => builder,
        eq: (_col: string, value: string) => {
          rateId = value;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: (table === 'shipping_rates' ? rows[rateId] : drafts[rateId]) ?? null,
          error: null,
        }),
      };
      return builder;
    },
  } as never;
}

describe('loadShippingRateResource', () => {
  it('builds a resource from its own row + its own latest draft', async () => {
    const fields = buildShippingRateFields('domestic', {
      domestic: DEFAULT_DOMESTIC_SHIPPING,
      international: DEFAULT_INTERNATIONAL_SHIPPING,
    });
    const resource = await loadShippingRateResource(
      makeSupabase({ domestic: { published_revision: 3 } }, { domestic: { revision: 4, payload: { fields } } }),
      'domestic',
    );
    expect(resource).toEqual({
      id: 'domestic',
      kind: 'shipping-rates',
      name: SHIPPING_RATE_NAMES.domestic,
      revision: 4,
      publishedRevision: 3,
      fields,
    });
  });

  it('surfaces a never-published row as publishedRevision null', async () => {
    const resource = await loadShippingRateResource(
      makeSupabase({ domestic: { published_revision: null } }, { domestic: { revision: 1, payload: { fields: [] } } }),
      'domestic',
    );
    expect(resource?.publishedRevision).toBeNull();
  });

  it('returns null when the shipping_rates row is absent', async () => {
    const resource = await loadShippingRateResource(makeSupabase({}, {}), 'international');
    expect(resource).toBeNull();
  });

  it('falls back to a warned, empty revision-0 draft when the row has no draft', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resource = await loadShippingRateResource(
      makeSupabase({ international: { published_revision: null } }, {}),
      'international',
    );
    expect(resource).toMatchObject({ revision: 0, fields: [] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('loadAllShippingRateResources', () => {
  it('returns both resources in SHIPPING_RATE_IDS order', async () => {
    const supabase = makeSupabase(
      { domestic: { published_revision: 1 }, international: { published_revision: 1 } },
      {
        domestic: { revision: 1, payload: { fields: [] } },
        international: { revision: 1, payload: { fields: [] } },
      },
    );
    const items = await loadAllShippingRateResources(supabase);
    expect(items.map((r) => r.id)).toEqual(['domestic', 'international']);
  });

  it('omits a resource whose row is absent rather than failing the whole list', async () => {
    const supabase = makeSupabase(
      { international: { published_revision: 1 } },
      { international: { revision: 1, payload: { fields: [] } } },
    );
    const items = await loadAllShippingRateResources(supabase);
    expect(items.map((r) => r.id)).toEqual(['international']);
  });
});
