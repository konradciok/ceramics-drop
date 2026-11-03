import type { SupabaseClient } from '@supabase/supabase-js';
import type { PrintPricingConfig } from '@/lib/print-pricing';
import type { PrintSize } from '@/lib/types';
import type { Field } from './types';

// ---------------------------------------------------------------------------
// Resource shape
// ---------------------------------------------------------------------------

// Pricing is a TRUE SINGLETON: one resource, under one fixed, well-known id.
// 'print-pricing' is not an arbitrary choice — it is already both the CMS mock
// fixture's id (cms-ceramics/src/lib/mock/fixtures.ts) and the sentinel
// catalog_audit_log.product_id the legacy writer
// (src/lib/print-pricing-config/repository.ts's updatePrintPricingConfig)
// has always used, so audit history stays continuous across the cutover.
export const PRICING_RESOURCE_ID = 'print-pricing';

// The display name is a fixed constant, not a stored, client-editable value:
// pricing_config_drafts.payload is {fields} only (no `name` key — see
// supabase/migrations/20260917140000_cms_api_pricing.sql). ResourceSave still
// carries `name` because the contract is shared across all four resource
// kinds; pricing-save.ts validates and then ignores it, exactly as
// content-save.ts does. Matches the CMS mock fixture's existing name.
export const PRICING_RESOURCE_NAME = 'Cennik Fine Art Print';

// Same generic Resource shape as CollectionResponse/ContentResponse — `kind:
// 'pricing'` is the only wire-level difference. Kept local to the pricing
// modules (same rationale as content-mapping.ts's ContentResponse).
export type PricingResponse = {
  id: string;
  kind: 'pricing';
  name: string;
  revision: number;
  publishedRevision: number | null;
  fields: Field[];
};

// ---------------------------------------------------------------------------
// The 11 fields — the one key map shared by save, publish, restore and preview
// ---------------------------------------------------------------------------

// Field.key IS the print_pricing_config column name, verbatim. That is
// deliberate: publish_pricing_revision writes exactly those columns, so the
// plpgsql side needs no translation table at all, and a fieldErrors key names
// the exact column whose CHECK constraint would otherwise have fired.
//
// `configPath` is the same value's path inside PrintPricingConfig — i.e.
// inside src/lib/print-pricing-config/schema.ts's printPricingConfigSchema,
// which pricing-validation.ts delegates all range checking to rather than
// restating any bound of its own.
//
// Keys and labels are kept in lockstep with the migration's one-time backfill
// by pricing-mapping.test.ts, which parses the migration SQL directly.
export type PricingFieldDef =
  | { key: string; label: string; kind: 'eur'; group: 'baseEur' | 'frameEur' | 'mountEur'; size: PrintSize; configPath: string }
  | { key: string; label: string; kind: 'rate'; rate: 'eurToPln' | 'eurToGbp'; configPath: string };

function eurDef(group: 'baseEur' | 'frameEur' | 'mountEur', size: PrintSize, key: string, label: string): PricingFieldDef {
  return { key, label, kind: 'eur', group, size, configPath: `${group}.${size}` };
}

function rateDef(rate: 'eurToPln' | 'eurToGbp', key: string, label: string): PricingFieldDef {
  return { key, label, kind: 'rate', rate, configPath: rate };
}

export const PRICING_FIELD_DEFS: readonly PricingFieldDef[] = [
  eurDef('baseEur', '30x40', 'base_30x40_eur', 'Cena bazowa 30 × 40 cm (EUR)'),
  eurDef('baseEur', '50x70', 'base_50x70_eur', 'Cena bazowa 50 × 70 cm (EUR)'),
  eurDef('baseEur', '70x100', 'base_70x100_eur', 'Cena bazowa 70 × 100 cm (EUR)'),
  eurDef('frameEur', '30x40', 'frame_30x40_eur', 'Dopłata za ramę 30 × 40 cm (EUR)'),
  eurDef('frameEur', '50x70', 'frame_50x70_eur', 'Dopłata za ramę 50 × 70 cm (EUR)'),
  eurDef('frameEur', '70x100', 'frame_70x100_eur', 'Dopłata za ramę 70 × 100 cm (EUR)'),
  eurDef('mountEur', '30x40', 'mount_30x40_eur', 'Dopłata za passe-partout 30 × 40 cm (EUR)'),
  eurDef('mountEur', '50x70', 'mount_50x70_eur', 'Dopłata za passe-partout 50 × 70 cm (EUR)'),
  eurDef('mountEur', '70x100', 'mount_70x100_eur', 'Dopłata za passe-partout 70 × 100 cm (EUR)'),
  rateDef('eurToPln', 'eur_to_pln', 'Kurs EUR → PLN (wynik zaokrąglany do 5 zł)'),
  rateDef('eurToGbp', 'eur_to_gbp', 'Kurs EUR → GBP (wynik zaokrąglany do 1 £)'),
];

export const PRICING_FIELD_KEYS: readonly string[] = PRICING_FIELD_DEFS.map((d) => d.key);

/** configPath ("baseEur.30x40", "eurToPln") -> Field key, for mapping zod issue paths back. */
export const PRICING_KEY_BY_CONFIG_PATH: ReadonlyMap<string, string> = new Map(
  PRICING_FIELD_DEFS.map((d) => [d.configPath, d.key]),
);

/**
 * PrintPricingConfig -> the 11 Fields, in PRICING_FIELD_DEFS order. Values are
 * plain decimal strings: EUR values are whole-euro integers, so String() is
 * exact; the two rates carry at most 4 decimals (numeric(8,4)), so String()
 * never reaches exponent notation for any value the validator admits.
 */
export function buildPricingFields(config: PrintPricingConfig): Field[] {
  return PRICING_FIELD_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    type: 'number' as const,
    value: def.kind === 'eur' ? String(config[def.group][def.size]) : String(config[def.rate]),
    locale: 'none' as const,
    sourceLocale: 'none' as const,
  }));
}

/**
 * Field[] -> {key: rawValue}. Pure; performs no validation whatsoever.
 * Duplicate keys resolve to the LAST occurrence, matching
 * pricing_config_draft_values()'s jsonb_object_agg semantics in the migration
 * — so TS and plpgsql cannot disagree about which duplicate wins.
 */
export function pricingFieldValues(fields: Field[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) values[field.key] = field.value;
  return values;
}

// ---------------------------------------------------------------------------
// I/O — always over the handler context's ctx.supabase (built by
// request-handler.ts's deps.makeSupabase(env)). Never adminSupabase() /
// getCloudflareContext(): CmsApi is a WorkerEntrypoint invoked over a service
// binding and is never wrapped by runWithCloudflareRequestContext, so those
// would throw in production (see request-handler.test.ts's Task 5 regression).
// ---------------------------------------------------------------------------

type PricingDraftPayload = { fields: Field[] };

/**
 * The singleton resource: published_revision from the live
 * print_pricing_config row, plus the highest-revision pricing_config_drafts
 * payload. Returns null only when the live row itself is absent — i.e. the
 * 20260807120000 migration was never applied, in which case there is no
 * pricing resource to speak of and the handlers surface a 404.
 */
export async function loadPricingResource(supabase: SupabaseClient): Promise<PricingResponse | null> {
  const [configRes, draftRes] = await Promise.all([
    supabase.from('print_pricing_config').select('published_revision').maybeSingle(),
    supabase
      .from('pricing_config_drafts')
      .select('revision, payload')
      .order('revision', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (configRes.error) throw configRes.error;
  if (draftRes.error) throw draftRes.error;
  if (!configRes.data) return null;

  const config = configRes.data as { published_revision: number | null };
  const draft = draftRes.data as { revision: number; payload: PricingDraftPayload } | null;

  // The 20260917140000 migration's one-time backfill seeds revision 1 in the
  // same transaction that adds published_revision, so a live row with no draft
  // is data corruption, not a normal state. Fall back to a revision-0 empty
  // draft rather than throwing (so the anomaly surfaces as a readable response
  // instead of a 500 that hides it) and log it — same posture and `[cms-api]`
  // prefix as collections-mapping.ts's equivalent fallback.
  if (!draft) {
    console.warn('[cms-api] print_pricing_config has no pricing_config_drafts row — falling back to an empty revision-0 draft');
  }

  return {
    id: PRICING_RESOURCE_ID,
    kind: 'pricing',
    name: PRICING_RESOURCE_NAME,
    revision: draft?.revision ?? 0,
    publishedRevision: config.published_revision,
    fields: draft?.payload?.fields ?? [],
  };
}
