import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PRICING_FIELD_DEFS,
  PRICING_FIELD_KEYS,
  PRICING_RESOURCE_ID,
  PRICING_RESOURCE_NAME,
  buildPricingFields,
  loadPricingResource,
  pricingFieldValues,
} from './pricing-mapping';
import { DEFAULT_PRINT_PRICING } from '@/lib/print-pricing';
import type { Field } from './types';

const CMS_API_PRICING_MIGRATION = join(
  __dirname,
  '../../../supabase/migrations/20260917140000_cms_api_pricing.sql',
);

describe('PRICING_FIELD_DEFS', () => {
  it('describes exactly 11 fields', () => {
    expect(PRICING_FIELD_DEFS).toHaveLength(11);
  });

  it('has distinct keys, and PRICING_FIELD_KEYS mirrors them in order', () => {
    expect(new Set(PRICING_FIELD_KEYS).size).toBe(11);
    expect(PRICING_FIELD_KEYS).toEqual(PRICING_FIELD_DEFS.map((d) => d.key));
  });

  it('uses the print_pricing_config column names verbatim as Field keys', () => {
    expect(PRICING_FIELD_KEYS).toEqual([
      'base_30x40_eur',
      'base_50x70_eur',
      'base_70x100_eur',
      'frame_30x40_eur',
      'frame_50x70_eur',
      'frame_70x100_eur',
      'mount_30x40_eur',
      'mount_50x70_eur',
      'mount_70x100_eur',
      'eur_to_pln',
      'eur_to_gbp',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The day-one agreement guard. The migration's one-time backfill seeds
// pricing_config_drafts revision 1 from the live print_pricing_config row and
// stamps published_revision = 1 — so the Field keys/labels it writes MUST be
// the ones this module reads back, or the CMS's first GET would show an empty
// or mislabelled form for a resource the migration just declared published.
// Docker is unreachable in this environment (the migration cannot be run), so
// this static parse is the strongest available check that the two sides agree.
// Same guard style as src/lib/print-pricing-config/migration-lockstep.test.ts.
// ---------------------------------------------------------------------------
describe('20260917140000_cms_api_pricing.sql backfill lockstep', () => {
  const sql = readFileSync(CMS_API_PRICING_MIGRATION, 'utf8');
  const seeded = [...sql.matchAll(/jsonb_build_object\(\s*'key',\s*'([^']+)',\s*'label',\s*'([^']+)'/g)].map(
    (m) => ({ key: m[1], label: m[2] }),
  );

  it('seeds exactly the 11 keys and labels this module defines, in the same order', () => {
    expect(seeded).toEqual(PRICING_FIELD_DEFS.map((d) => ({ key: d.key, label: d.label })));
  });

  it('stamps published_revision = 1 in the same migration as the revision-1 seed', () => {
    expect(sql).toMatch(/insert into pricing_config_drafts \(revision, payload, created_by\)/);
    expect(sql).toMatch(/update print_pricing_config c set published_revision = 1 where c\.id;/);
  });
});

describe('buildPricingFields', () => {
  it('produces 11 number-typed, locale-none fields in PRICING_FIELD_DEFS order', () => {
    const fields = buildPricingFields(DEFAULT_PRINT_PRICING);
    expect(fields).toHaveLength(11);
    expect(fields.map((f) => f.key)).toEqual(PRICING_FIELD_KEYS);
    for (const field of fields) {
      expect(field.type).toBe('number');
      expect(field.locale).toBe('none');
      expect(field.sourceLocale).toBe('none');
      expect(typeof field.value).toBe('string');
    }
  });

  it('serialises the 9 EUR integers and the 2 rates as plain decimal strings', () => {
    const byKey = Object.fromEntries(buildPricingFields(DEFAULT_PRINT_PRICING).map((f) => [f.key, f.value]));
    expect(byKey.base_30x40_eur).toBe('25');
    expect(byKey.base_50x70_eur).toBe('50');
    expect(byKey.base_70x100_eur).toBe('75');
    expect(byKey.frame_30x40_eur).toBe('35');
    expect(byKey.mount_70x100_eur).toBe('25');
    expect(byKey.eur_to_pln).toBe('4.25');
    expect(byKey.eur_to_gbp).toBe('0.86');
  });
});

describe('pricingFieldValues', () => {
  const f = (key: string, value: string): Field => ({ key, label: key, type: 'number', value, locale: 'none', sourceLocale: 'none' });

  it('maps key -> value', () => {
    expect(pricingFieldValues([f('eur_to_pln', '4.25')])).toEqual({ eur_to_pln: '4.25' });
  });

  it('resolves duplicates to the LAST occurrence, matching the RPC jsonb_object_agg', () => {
    expect(pricingFieldValues([f('eur_to_pln', '4.25'), f('eur_to_pln', '4.50')])).toEqual({ eur_to_pln: '4.50' });
  });

  it('returns an empty map for an empty field list', () => {
    expect(pricingFieldValues([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// loadPricingResource — thin I/O over ctx.supabase. Never adminSupabase() /
// getCloudflareContext() (see the Task 5 regression in request-handler.test.ts).
// ---------------------------------------------------------------------------
function makeSupabase(config: unknown, draft: unknown) {
  return {
    from(table: string) {
      const data = table === 'print_pricing_config' ? config : draft;
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data, error: null }),
      };
      return builder;
    },
  } as never;
}

describe('loadPricingResource', () => {
  it('builds the singleton resource from the live row + the latest draft', async () => {
    const fields = buildPricingFields(DEFAULT_PRINT_PRICING);
    const resource = await loadPricingResource(
      makeSupabase({ published_revision: 3 }, { revision: 4, payload: { fields } }),
    );
    expect(resource).toEqual({
      id: PRICING_RESOURCE_ID,
      kind: 'pricing',
      name: PRICING_RESOURCE_NAME,
      revision: 4,
      publishedRevision: 3,
      fields,
    });
  });

  it('surfaces a never-published live row as publishedRevision null', async () => {
    const resource = await loadPricingResource(
      makeSupabase({ published_revision: null }, { revision: 1, payload: { fields: [] } }),
    );
    expect(resource?.publishedRevision).toBeNull();
  });

  it('returns null when the print_pricing_config singleton row is absent', async () => {
    const resource = await loadPricingResource(makeSupabase(null, { revision: 1, payload: { fields: [] } }));
    expect(resource).toBeNull();
  });

  it('falls back to a warned, empty revision-0 draft when no draft row exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resource = await loadPricingResource(makeSupabase({ published_revision: null }, null));
    expect(resource).toMatchObject({ revision: 0, fields: [] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
