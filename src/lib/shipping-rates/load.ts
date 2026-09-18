/* ============================================================
   Shipping rates loader — direct DB read for the checkout accessor.
   ------------------------------------------------------------
   Mirrors src/lib/print-pricing-config/{load,repository}.ts: callers inject the
   Supabase client (service-role) into readShippingRates and errors THROW —
   ./get.ts is the only place a failure turns into a fallback.

   The live values are the payload of each resource's PUBLISHED revision, not
   its newest draft: publish_shipping_rate_revision only moves
   shipping_rates.published_revision, so saving or restoring a draft must never
   change what checkout charges. That pointer is what this module follows.

   loadShippingRatesFromDb is server-only (getSupabaseAdmin needs the Workers
   request context) and is reached via dynamic import from ./get.ts, so `code`
   mode and client bundles never touch it.
   ============================================================ */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../supabase';
import { supabaseTimeout } from '../supabase-timeout';
import {
  SHIPPING_RATE_IDS,
  type ShippingRateId,
} from '@/server/cms-api/shipping-rates-mapping';
import { parseShippingRateFields } from '@/server/cms-api/shipping-rates-validation';
import type { Field } from '@/server/cms-api/types';
import type { ShippingRatesBundle } from './last-known-good';

type RateRow = { id: string; published_revision: number | null };
type DraftRow = { payload: { fields?: Field[] } };

async function readPublishedFields(
  supabase: SupabaseClient,
  rateId: ShippingRateId,
  revision: number,
): Promise<Field[]> {
  const res = await supabase
    .from('shipping_rate_drafts')
    .select('payload')
    .eq('rate_id', rateId)
    .eq('revision', revision)
    .abortSignal(supabaseTimeout())
    .maybeSingle();
  if (res.error) throw new Error(`read shipping rates ${rateId}: ${res.error.message}`);
  if (!res.data) throw new Error(`shipping_rates_draft_missing: ${rateId}@${revision}`);
  return (res.data as DraftRow).payload?.fields ?? [];
}

/**
 * Read both tracks' published rate tables. Throws on any anomaly — a missing
 * row, a never-published resource, a vanished draft, or a payload that no
 * longer parses. Throwing is deliberate: ./get.ts turns it into the
 * last-known-good / code-constant fallback, which is a KNOWN price list.
 * Returning a half-built table would let checkout charge a nonsense amount.
 */
export async function readShippingRates(supabase: SupabaseClient): Promise<ShippingRatesBundle> {
  const res = await supabase
    .from('shipping_rates')
    .select('id, published_revision')
    .in('id', [...SHIPPING_RATE_IDS])
    .abortSignal(supabaseTimeout());
  if (res.error) throw new Error(`read shipping rates: ${res.error.message}`);

  const rows = (res.data ?? []) as RateRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));

  const parsed = await Promise.all(
    SHIPPING_RATE_IDS.map(async (rateId) => {
      const row = byId.get(rateId);
      if (!row) throw new Error(`shipping_rates_missing: ${rateId}`);
      if (row.published_revision == null) throw new Error(`shipping_rates_unpublished: ${rateId}`);

      const fields = await readPublishedFields(supabase, rateId, row.published_revision);
      const result = parseShippingRateFields(rateId, fields);
      if (!result.ok) {
        throw new Error(
          `shipping_rates_payload_invalid: ${rateId}@${row.published_revision} (${Object.keys(result.fieldErrors).join(',')})`,
        );
      }
      return result;
    }),
  );

  const domestic = parsed.find((r) => r.rateId === 'domestic');
  const international = parsed.find((r) => r.rateId === 'international');
  // Unreachable: SHIPPING_RATE_IDS drives the map above and every branch that
  // could omit one has already thrown. Narrowing only.
  if (!domestic || domestic.rateId !== 'domestic') throw new Error('shipping_rates_missing: domestic');
  if (!international || international.rateId !== 'international') throw new Error('shipping_rates_missing: international');

  return { domestic: domestic.rates, international: international.rates };
}

export async function loadShippingRatesFromDb(): Promise<ShippingRatesBundle> {
  return readShippingRates(getSupabaseAdmin());
}
