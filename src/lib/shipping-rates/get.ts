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
   split (getPrintPricingConfig vs getPrintPricingConfigForCheckout), but with
   ONE deliberate difference from that mirror: both shipping accessors share
   the SAME fallback ladder (last-known-good, then code-default) on a DB read
   failure, and both feed the same last-known-good store on success. Without
   that, a checkout-side success followed by a display-side failure (or vice
   versa) could still show the buyer a cart price different from what
   checkout charges — the exact gap this accessor exists to close. The
   PDP/feed/structured-data surfaces still read the code constants directly —
   those are pre-purchase SEO/marketing surfaces with no live cart to
   reconcile against, not a price the buyer is about to pay, so cutting them
   over is unchanged scope (see feed.ts / structured-data.ts for that
   boundary).
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

/**
 * For DISPLAY only (the cart page) — never throws, so a DB read failure
 * never hard-fails the cart render (checkout re-resolves authoritatively and
 * independently regardless). On failure it shares the exact SAME fallback
 * ladder as getShippingRatesForCheckout — last-known-good first, then the
 * code constants — rather than jumping straight to the code constants: the
 * two accessors share the module-scoped last-known-good store (both record a
 * success into it), so whichever one last completed a DB read is what the
 * other degrades to on failure. Without this, a checkout-side success
 * followed by a display-side failure (or vice versa) could again show the
 * buyer a cart price different from what checkout charges — the exact class
 * of bug this accessor exists to close (flagged in review, see PR #330).
 */
export async function getShippingRatesForDisplay(): Promise<ShippingRatesBundle> {
  if (catalogSource() === 'code') return CODE_SHIPPING_RATES;
  try {
    const { loadShippingRatesFromDb } = await import('./load');
    const rates = await loadShippingRatesFromDb();
    recordShippingRatesSuccess(rates);
    return rates;
  } catch (err) {
    const { rates, tier } = resolveShippingRatesFallback();
    console.error('[shipping-rates] DB read failed (display); using fallback', { fallbackTier: tier }, err);
    Sentry.captureException(err, { tags: { supabaseTimeoutLabel: 'shipping-rates-display', fallbackTier: tier } });
    return rates;
  }
}
