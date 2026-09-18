import type { SupabaseClient } from '@supabase/supabase-js';
import type { Currency } from '@/lib/currency';
import { type DeliveryMethod, type DomesticShippingRates } from '@/lib/pricing';
import { PRINT_COUNTRIES, type InternationalShippingRates, type PrintCountry } from '@/lib/print-shipping';
import type { Field } from './types';

// ---------------------------------------------------------------------------
// Resource shape
// ---------------------------------------------------------------------------

// TWO resources, one per fulfilment track — not a singleton like pricing, and
// not an open-ended list like collections. A cart is never mixed between the
// two tracks (enforced in src/lib/checkout.ts / src/app/api/checkout/route.ts),
// and the two price lists have always been maintained as separate modules
// (src/lib/pricing.ts vs src/lib/print-shipping.ts), so they publish
// independently. The ids are the plan's, verbatim.
export const SHIPPING_RATE_IDS = ['domestic', 'international'] as const;
export type ShippingRateId = (typeof SHIPPING_RATE_IDS)[number];

export function isShippingRateId(id: string): id is ShippingRateId {
  return (SHIPPING_RATE_IDS as readonly string[]).includes(id);
}

// Display names are fixed constants, not stored client-editable values:
// shipping_rate_drafts.payload is {fields} only (see the migration). Same
// posture as PRICING_RESOURCE_NAME / content's fixed labels.
export const SHIPPING_RATE_NAMES: Record<ShippingRateId, string> = {
  domestic: 'Dostawa krajowa (InPost)',
  international: 'Dostawa zagraniczna (Prodigi)',
};

// Same generic Resource shape as CollectionResponse/PricingResponse — `kind:
// 'shipping-rates'` is the only wire-level difference.
export type ShippingRatesResponse = {
  id: ShippingRateId;
  kind: 'shipping-rates';
  name: string;
  revision: number;
  publishedRevision: number | null;
  fields: Field[];
};

/** Both tracks' live values, as the resilience layer and checkout use them. */
export type ShippingRatesBundle = {
  domestic: DomesticShippingRates;
  international: InternationalShippingRates;
};

// ---------------------------------------------------------------------------
// The 9 + 56 field definitions
// ---------------------------------------------------------------------------

// Unlike pricing, whose Field.key IS a print_pricing_config column name, these
// resources have NO live value columns anywhere: publishing a shipping-rates
// revision only stamps shipping_rates.published_revision, and the published
// draft's payload is itself the live value (exactly like collections). So the
// keys are chosen rather than inherited, following pricing's conventions:
// lower snake_case with an explicit currency suffix, mechanically derivable
// from the two source constants so 56 entries never have to be hand-written.
//
// Keys AND labels are kept in lockstep with the migration's one-time backfill
// by shipping-rates-mapping.test.ts, which parses the migration SQL directly —
// same guard style as pricing-mapping.test.ts and
// src/lib/print-pricing-config/migration-lockstep.test.ts.

export type DomesticFieldDef = {
  key: string;
  label: string;
  rateId: 'domestic';
  currency: Currency;
  method: DeliveryMethod;
};

export type InternationalFieldDef = {
  key: string;
  label: string;
  rateId: 'international';
  country: PrintCountry;
  pack: 'framed' | 'loose';
};

export type ShippingRateFieldDef = DomesticFieldDef | InternationalFieldDef;

// Currency-major, so the nine fields read down the page as the three source
// constants (SHIPPING_PLN, then SHIPPING_EUR, then SHIPPING_GBP) do.
const DOMESTIC_CURRENCIES: readonly Currency[] = ['pln', 'eur', 'gbp'];
const DOMESTIC_METHODS: readonly DeliveryMethod[] = ['paczkomat', 'kurier', 'odbior'];
const DOMESTIC_METHOD_LABELS: Record<DeliveryMethod, string> = {
  paczkomat: 'Paczkomat InPost',
  kurier: 'Kurier InPost',
  odbior: 'Odbiór w pracowni',
};

export const DOMESTIC_FIELD_DEFS: readonly DomesticFieldDef[] = DOMESTIC_CURRENCIES.flatMap((currency) =>
  DOMESTIC_METHODS.map((method) => ({
    key: `${method}_${currency}`,
    label: `${DOMESTIC_METHOD_LABELS[method]} (${currency.toUpperCase()})`,
    rateId: 'domestic' as const,
    currency,
    method,
  })),
);

const PACKS = ['framed', 'loose'] as const;
const PACK_LABELS: Record<(typeof PACKS)[number], string> = {
  framed: 'w ramie',
  loose: 'bez ramy',
};

export const INTERNATIONAL_FIELD_DEFS: readonly InternationalFieldDef[] = PRINT_COUNTRIES.flatMap((country) =>
  PACKS.map((pack) => ({
    key: `${country.toLowerCase()}_${pack}_eur`,
    label: `Wysyłka ${country} — ${PACK_LABELS[pack]} (EUR)`,
    rateId: 'international' as const,
    country,
    pack,
  })),
);

export const SHIPPING_RATE_FIELD_DEFS: Record<ShippingRateId, readonly ShippingRateFieldDef[]> = {
  domestic: DOMESTIC_FIELD_DEFS,
  international: INTERNATIONAL_FIELD_DEFS,
};

export function shippingRateFieldKeys(rateId: ShippingRateId): string[] {
  return SHIPPING_RATE_FIELD_DEFS[rateId].map((def) => def.key);
}

/**
 * The live rate tables -> that resource's Fields, in definition order.
 *
 * Values are plain decimal strings. Domestic amounts are whole major units and
 * international amounts are 2-decimal Prodigi quotes, so String() is exact and
 * never reaches exponent notation for any value the validator admits (note it
 * also trims a trailing zero the way JS always has: 7.30 serialises as '7.3',
 * which is the same number — the SQL backfill trims identically).
 */
export function buildShippingRateFields(rateId: ShippingRateId, rates: ShippingRatesBundle): Field[] {
  return SHIPPING_RATE_FIELD_DEFS[rateId].map((def) => ({
    key: def.key,
    label: def.label,
    type: 'number' as const,
    value:
      def.rateId === 'domestic'
        ? String(rates.domestic[def.currency][def.method])
        : String(rates.international[def.country][def.pack]),
    locale: 'none' as const,
    sourceLocale: 'none' as const,
  }));
}

/**
 * Field[] -> {key: rawValue}. Pure; performs no validation whatsoever.
 * Duplicate keys resolve to the LAST occurrence, matching
 * shipping_rate_draft_values()'s jsonb_object_agg semantics in the migration —
 * so TS and plpgsql cannot disagree about which duplicate wins.
 */
export function shippingRateFieldValues(fields: Field[]): Record<string, string> {
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

type ShippingRateDraftPayload = { fields: Field[] };

/**
 * One resource: published_revision from its shipping_rates row, plus its
 * highest-revision shipping_rate_drafts payload. Returns null only when the
 * row itself is absent — i.e. the 20260917150000 migration was never applied,
 * in which case there is no such resource and the handlers surface a 404.
 */
export async function loadShippingRateResource(
  supabase: SupabaseClient,
  rateId: ShippingRateId,
): Promise<ShippingRatesResponse | null> {
  const [rowRes, draftRes] = await Promise.all([
    supabase.from('shipping_rates').select('published_revision').eq('id', rateId).maybeSingle(),
    supabase
      .from('shipping_rate_drafts')
      .select('revision, payload')
      .eq('rate_id', rateId)
      .order('revision', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (rowRes.error) throw rowRes.error;
  if (draftRes.error) throw draftRes.error;
  if (!rowRes.data) return null;

  const row = rowRes.data as { published_revision: number | null };
  const draft = draftRes.data as { revision: number; payload: ShippingRateDraftPayload } | null;

  // The migration's one-time backfill seeds revision 1 for BOTH rows in the
  // same transaction that creates them, so a row with no draft is data
  // corruption, not a normal state. Fall back to a revision-0 empty draft
  // rather than throwing (so the anomaly surfaces as a readable response
  // instead of a 500 that hides it) and log it — same posture and `[cms-api]`
  // prefix as pricing-mapping.ts / collections-mapping.ts.
  if (!draft) {
    console.warn(`[cms-api] shipping_rates ${rateId} has no shipping_rate_drafts row — falling back to an empty revision-0 draft`);
  }

  return {
    id: rateId,
    kind: 'shipping-rates',
    name: SHIPPING_RATE_NAMES[rateId],
    revision: draft?.revision ?? 0,
    publishedRevision: row.published_revision,
    fields: draft?.payload?.fields ?? [],
  };
}

/** Both resources, in SHIPPING_RATE_IDS order; absent rows are simply omitted. */
export async function loadAllShippingRateResources(supabase: SupabaseClient): Promise<ShippingRatesResponse[]> {
  const resources = await Promise.all(SHIPPING_RATE_IDS.map((id) => loadShippingRateResource(supabase, id)));
  return resources.filter((resource): resource is ShippingRatesResponse => resource !== null);
}
