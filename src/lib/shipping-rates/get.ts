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

   Display surfaces — the cart, PDP, the product feed, structured data — keep
   reading the code constants directly for now; only the money path is cut over
   (the plan's scope). They call printShippingOf / shippingOfCurrency with no
   table argument, which resolves to those same constants.
   ============================================================ */
import * as Sentry from '@sentry/nextjs';
import { catalogSource } from '../catalog/source';
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
