/* ============================================================
   Public accessor for the published shipping rates.
   ------------------------------------------------------------
   Mirrors print-pricing-config/get.ts: CATALOG_SOURCE=code (local/tests)
   returns the code constants; 'db' (production) reads the currently PUBLISHED
   revision of both shipping-rate resources. The dynamic import keeps
   Cloudflare-only code (the Supabase admin client) out of the code-mode path
   and any client bundle.

   ONE accessor, BOTH tracks, on purpose. The plan requires the checkout
   cutover to be atomic — there must never be a window where domestic shipping
   is priced from the DB and international from the constants, or vice versa.
   Handing checkout a single value that always carries both tables makes that
   property structural rather than a thing reviewers have to notice: a fallback
   moves both tracks together, and src/app/api/checkout/route.ts has exactly one
   call site feeding both of its branches.

   Unlike getPrintPricingConfigForCheckout, this NEVER throws and never blocks a
   purchase — see last-known-good.ts's header for the reasoning (before this
   feature existed both tracks were served entirely from these constants, so
   failing closed would be a pure availability regression).

   Cart display now reads the SAME published rates as checkout, via
   getShippingRatesForDisplay() below — mirroring the print-pricing-config
   split (getPrintPricingConfig vs getPrintPricingConfigForCheckout). This
   closes the one gap that mattered: a buyer could previously see one price
   in the cart and be charged a different (correct) one at checkout after an
   admin edited the CMS rates. The PDP/feed/structured-data surfaces still
   read the code constants directly — those are pre-purchase SEO/marketing
   surfaces with no live cart to reconcile against, not a price the buyer is
   about to pay, so cutting them over is unchanged scope (see feed.ts /
   structured-data.ts for that boundary).
   ============================================================ */
import * as Sentry from '@sentry/nextjs';
import { catalogSource } from '../catalog/source';
import { readWithFallback } from '../supabase-timeout';
import {
  CODE_SHIPPING_RATES,
  recordShippingRatesSuccess,
  resolveShippingRatesFallback,
  type ShippingRatesBundle,
} from './last-known-good';

export type { ShippingRatesBundle };

export async function getShippingRatesForCheckout(): Promise<ShippingRatesBundle> {
  if (catalogSource() === 'code') return CODE_SHIPPING_RATES;
  try {
    const { loadShippingRatesFromDb } = await import('./load');
    const rates = await loadShippingRatesFromDb();
    recordShippingRatesSuccess(rates);
    return rates;
  } catch (err) {
    const { rates, tier } = resolveShippingRatesFallback();
    console.error('[shipping-rates] DB read failed (checkout); using fallback', { fallbackTier: tier }, err);
    // fallbackTier as a tag (not `extra`) so the two tiers are filterable in
    // Sentry, distinct from a generic Supabase hiccup — same convention as
    // print-pricing-config/get.ts and catalog/last-known-good.ts.
    Sentry.captureException(err, { tags: { supabaseTimeoutLabel: 'shipping-rates-checkout', fallbackTier: tier } });
    return rates;
  }
}

/**
 * For DISPLAY only (the cart page) — degrades to CODE_SHIPPING_RATES on a DB
 * read failure so a transient hiccup never hard-fails the cart render. A
 * stale rate shown before the buyer has paid is not a money-safety issue
 * (checkout re-resolves authoritatively via getShippingRatesForCheckout).
 * Same posture as print-pricing-config/get.ts's getPrintPricingConfig().
 */
export async function getShippingRatesForDisplay(): Promise<ShippingRatesBundle> {
  if (catalogSource() === 'code') return CODE_SHIPPING_RATES;
  return readWithFallback('shipping-rates-display', async () => {
    const { loadShippingRatesFromDb } = await import('./load');
    return await loadShippingRatesFromDb();
  }, CODE_SHIPPING_RATES);
}
