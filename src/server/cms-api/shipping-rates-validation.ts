import { z } from 'zod';
import type { DeliveryMethod, DomesticShippingRates } from '@/lib/pricing';
import type { Currency } from '@/lib/currency';
import type { InternationalShippingRates } from '@/lib/print-shipping';
import { SHIPPING_RATE_FIELD_DEFS, shippingRateFieldValues, type ShippingRateId } from './shipping-rates-mapping';
import type { Field } from './types';

// ---------------------------------------------------------------------------
// Generic ResourceSave — verbatim from contracts/cms-v1.json, same shape every
// resource kind shares. Kept as its own module per this codebase's
// one-module-per-kind convention (see content-validation.ts / pricing-validation.ts).
// There is no ResourceCreate schema: the two shipping-rate resources are
// created by the migration and there is no POST /v1/shipping-rates.
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

export type ShippingRatesSaveResult =
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
 * Validates the ResourceSave envelope ONLY — shape, not shipping ranges. A
 * draft may legitimately hold out-of-range or half-typed values while the
 * operator is mid-edit; ranges are enforced at publish time by
 * parseShippingRateFields below (and, authoritatively, by
 * publish_shipping_rate_revision).
 */
export function validateShippingRatesSave(body: unknown): ShippingRatesSaveResult {
  const result = resourceSaveSchema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, fieldErrors: collectFieldErrors(result.error) };
}

// ---------------------------------------------------------------------------
// The publish-time parser: a resource's Fields -> its live rate table
// ---------------------------------------------------------------------------

// Literal format, chosen to agree EXACTLY with publish_shipping_rate_revision's
// own regex in supabase/migrations/20260917150000_cms_api_shipping_rates.sql,
// so a payload this parser accepts can never be rejected by the RPC on format
// grounds (and vice versa). Deliberately stricter than Number(): '2e1', '+5',
// '0x10', 'Infinity' and '1_000' are all things Number() would happily coerce
// and Postgres' numeric input would not accept the same way.
const DECIMAL_LITERAL = /^-?[0-9]+(\.[0-9]+)?$/;

const MSG_REQUIRED = 'Uzupełnij tę wartość.';
const MSG_DECIMAL = 'Podaj kwotę, np. 12.95.';
const MSG_NEGATIVE = 'Kwota nie może być ujemna.';
const MSG_PRECISION = 'Najwyżej dwa miejsca po przecinku.';

export type ShippingRatesParseResult =
  | { ok: true; rateId: 'domestic'; rates: DomesticShippingRates }
  | { ok: true; rateId: 'international'; rates: InternationalShippingRates }
  | { ok: false; fieldErrors: Record<string, string> };

/**
 * Parses one resource's known Field keys into the live rate table checkout
 * charges from, re-validating the ranges publish_shipping_rate_revision
 * enforces so a bad value fails with a per-field message instead of an opaque
 * `shipping_rates_invalid`.
 *
 * Unlike parsePricingFields, there is no external schema to delegate to: these
 * values have no DB columns and therefore no CHECK constraints of their own
 * (publishing only stamps shipping_rates.published_revision). The three rules
 * below are the complete specification, and the RPC states them identically:
 *   - a plain decimal literal (no exponent, sign prefix, separator or hex),
 *   - >= 0,
 *   - at most 2 decimal places. These are MAJOR currency units that checkout
 *     turns into minor units (toMinor()'s round(v x 100) for domestic,
 *     Math.ceil for international), so a third decimal would be silently
 *     rounded away at charge time.
 *
 * Unknown extra keys are ignored, exactly as parsePricingFields ignores them:
 * only the resource's own definitions are read. Every bad key is reported at
 * once — never short-circuited on the first — so the operator fixes one form,
 * not one field per round trip.
 *
 * NOTE: `eur_to_pln` / `eur_to_gbp` are not keys of either resource and never
 * will be. International shipping converts through the print pricing config's
 * single copy of those rates (see print-shipping.ts's printShippingOf); a
 * second source would let item prices and shipping drift apart on one order.
 */
export function parseShippingRateFields(rateId: ShippingRateId, fields: Field[]): ShippingRatesParseResult {
  const values = shippingRateFieldValues(fields);
  const fieldErrors: Record<string, string> = {};
  const numbers = new Map<string, number>();

  for (const def of SHIPPING_RATE_FIELD_DEFS[rateId]) {
    const raw = (values[def.key] ?? '').trim();
    if (raw === '') {
      fieldErrors[def.key] = MSG_REQUIRED;
      continue;
    }
    if (!DECIMAL_LITERAL.test(raw)) {
      fieldErrors[def.key] = MSG_DECIMAL;
      continue;
    }
    const num = Number(raw);
    if (num < 0) {
      fieldErrors[def.key] = MSG_NEGATIVE;
      continue;
    }
    // "v x 100 is a whole number", NOT "the literal has <= 2 decimals": the
    // literal's trailing zeros carry no value, so '20.500' is accepted (it IS
    // 20.5) while '20.005' is not — trailing-zero agnostic, so it cannot
    // disagree with the RPC's exact-numeric test. The 1e-9 slack absorbs IEEE
    //754 representation error (e.g. 132.43 * 100 = 13242.999999999998), which
    // Postgres' exact numerics do not have; it is far smaller than the 0.01
    // step the rule is about, so no genuinely 3-decimal value slips through.
    const scaled = num * 100;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
      fieldErrors[def.key] = MSG_PRECISION;
      continue;
    }
    numbers.set(def.key, num);
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  if (rateId === 'domestic') {
    const rates = { pln: {}, eur: {}, gbp: {} } as Record<Currency, Record<DeliveryMethod, number>>;
    for (const def of SHIPPING_RATE_FIELD_DEFS.domestic) {
      if (def.rateId !== 'domestic') continue;
      rates[def.currency][def.method] = numbers.get(def.key) as number;
    }
    return { ok: true, rateId, rates };
  }

  const rates = {} as InternationalShippingRates;
  for (const def of SHIPPING_RATE_FIELD_DEFS.international) {
    if (def.rateId !== 'international') continue;
    const entry = (rates[def.country] ??= {} as { framed: number; loose: number });
    entry[def.pack] = numbers.get(def.key) as number;
  }
  return { ok: true, rateId, rates };
}
