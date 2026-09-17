import { z } from 'zod';
import { printPricingConfigSchema } from '@/lib/print-pricing-config/schema';
import type { PrintPricingConfig } from '@/lib/print-pricing';
import { PRICING_FIELD_DEFS, PRICING_KEY_BY_CONFIG_PATH, pricingFieldValues } from './pricing-mapping';
import type { Field } from './types';

// ---------------------------------------------------------------------------
// Generic ResourceSave — verbatim from contracts/cms-v1.json, same shape every
// resource kind shares. Kept as its own module per this codebase's
// one-module-per-kind convention (see content-validation.ts's header).
// There is no ResourceCreate schema: pricing is a singleton with no POST
// /v1/pricing create endpoint.
// ---------------------------------------------------------------------------
const FIELD_TYPES = ['text', 'richtext', 'number', 'productIds'] as const;
const FIELD_LOCALES = ['pl', 'en', 'es', 'de', 'none'] as const;

export const fieldSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    type: z.enum(FIELD_TYPES),
    value: z.string(),
    locale: z.enum(FIELD_LOCALES),
    sourceLocale: z.enum(FIELD_LOCALES),
  })
  .strict();

export const resourceSaveSchema = z
  .object({
    expectedRevision: z.number().int(),
    name: z.string().trim().min(1),
    fields: z.array(fieldSchema),
  })
  .strict();

export type PricingSaveResult =
  | { ok: true; data: z.infer<typeof resourceSaveSchema> }
  | { ok: false; fieldErrors: Record<string, string> };

function collectFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '(root)';
    if (!fieldErrors[path]) fieldErrors[path] = issue.message;
  }
  return fieldErrors;
}

/**
 * Validates the ResourceSave envelope ONLY — shape, not pricing ranges. A
 * draft may legitimately hold out-of-range or half-typed values while the
 * operator is mid-edit; ranges are enforced at publish (and preview) time by
 * parsePricingFields below, exactly as the plan specifies.
 */
export function validatePricingSave(body: unknown): PricingSaveResult {
  const result = resourceSaveSchema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, fieldErrors: collectFieldErrors(result.error) };
}

// ---------------------------------------------------------------------------
// The publish/preview-time parser: 11 Fields -> one PrintPricingConfig
// ---------------------------------------------------------------------------

// Literal formats, chosen to agree EXACTLY with publish_pricing_revision's own
// regexes in supabase/migrations/20260917140000_cms_api_pricing.sql, so a
// payload this parser accepts can never be rejected by the RPC on format
// grounds (and vice versa). Deliberately stricter than Number(): '2e1',
// '+5', '0x10', 'Infinity' and ' 1_000 ' are all things Number() would happily
// coerce and Postgres' integer/numeric input would not accept the same way.
const INTEGER_LITERAL = /^-?[0-9]+$/;
const DECIMAL_LITERAL = /^-?[0-9]+(\.[0-9]+)?$/;

const MSG_REQUIRED = 'Uzupełnij tę wartość.';
const MSG_INTEGER = 'Podaj liczbę całkowitą (pełne euro, bez groszy).';
const MSG_DECIMAL = 'Podaj liczbę dziesiętną, np. 4.25.';

export type PricingParseResult =
  | { ok: true; config: PrintPricingConfig }
  | { ok: false; fieldErrors: Record<string, string> };

/**
 * Parses the 11 known Field keys into a PrintPricingConfig and re-validates
 * the ranges the print_pricing_config CHECK constraints already encode, so a
 * bad value fails with a per-field message instead of an opaque 23514.
 *
 * Range checking is DELEGATED to printPricingConfigSchema
 * (src/lib/print-pricing-config/schema.ts) — the very schema the legacy
 * /api/admin/print-pricing writer already validates against, and whose bounds
 * are documented as matching the column types and checks. Nothing here
 * restates a bound: introducing a second statement of the same ranges is
 * exactly the drift hazard this resource must not carry. Zod issue paths
 * ("baseEur.30x40", "eurToPln") are mapped back to Field keys (== column
 * names) so fieldErrors is keyed the way the client's own fields are.
 *
 * All 11 keys are reported at once — never short-circuited on the first bad
 * one — so the operator fixes one form, not one field per round trip.
 */
export function parsePricingFields(fields: Field[]): PricingParseResult {
  const values = pricingFieldValues(fields);
  const fieldErrors: Record<string, string> = {};
  const numbers = new Map<string, number>();

  for (const def of PRICING_FIELD_DEFS) {
    const raw = (values[def.key] ?? '').trim();
    if (raw === '') {
      fieldErrors[def.key] = MSG_REQUIRED;
      continue;
    }
    const isEur = def.kind === 'eur';
    if (!(isEur ? INTEGER_LITERAL : DECIMAL_LITERAL).test(raw)) {
      fieldErrors[def.key] = isEur ? MSG_INTEGER : MSG_DECIMAL;
      continue;
    }
    numbers.set(def.key, Number(raw));
  }

  // A malformed literal cannot be range-checked meaningfully, so report the
  // format problems and stop before the schema pass.
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  const perSize = (group: 'baseEur' | 'frameEur' | 'mountEur'): Record<string, number | undefined> => {
    const out: Record<string, number | undefined> = {};
    for (const def of PRICING_FIELD_DEFS) {
      if (def.kind === 'eur' && def.group === group) out[def.size] = numbers.get(def.key);
    }
    return out;
  };

  const candidate = {
    baseEur: perSize('baseEur'),
    frameEur: perSize('frameEur'),
    mountEur: perSize('mountEur'),
    eurToPln: numbers.get('eur_to_pln'),
    eurToGbp: numbers.get('eur_to_gbp'),
  };

  const parsed = printPricingConfigSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, config: parsed.data };

  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.');
    const key = PRICING_KEY_BY_CONFIG_PATH.get(path) ?? path ?? '(root)';
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return { ok: false, fieldErrors };
}
