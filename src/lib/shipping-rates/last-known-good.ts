/* ============================================================
   Shipping rates last-known-good — isolate-lifetime checkout fallback
   ------------------------------------------------------------
   getShippingRatesForCheckout() (get.ts) consults this on a DB read failure.
   Modelled on print-pricing-config/last-known-good.ts, with ONE deliberate
   difference: there is no cold-fail-closed tier here.

   Why pricing fails closed and shipping does not
   ----------------------------------------------
   Print pricing has no safe value to charge on a cold isolate — the hardcoded
   DEFAULT_PRINT_PRICING may be arbitrarily far from what the artist has since
   published, and the item price IS the order. So a cold isolate that cannot
   read the DB blocks the purchase.

   Shipping is the opposite case. Before the CmsApi /v1/shipping-rates cutover
   (supabase/migrations/20260917150000_cms_api_shipping_rates.sql) BOTH tracks
   read nothing but the code constants on every single checkout — domestic had
   no DB layer at all, and international's EUR table was likewise hardcoded.
   Those constants are exactly what the migration seeds as published revision 1,
   so on day one they are not a stale guess: they are the published values. Fail
   closed here and a transient Supabase hiccup would make checkout strictly LESS
   available than it was before this feature existed, for a cost component that
   is small, bounded, and fully visible to the buyer before they pay. So the
   fallback ladder is:

     1. last-known-good — the real published values this isolate last read,
     2. code-default    — the shipped constants (src/lib/pricing.ts's
                          SHIPPING_PLN/EUR/GBP, src/lib/print-shipping.ts's
                          SHIPPING_EUR), same role DEFAULT_PRINT_PRICING plays
                          for the DISPLAY pricing accessor.

   Both tiers are tagged on the Sentry event so a deployment running on tier 2
   for any length of time is visible rather than silent.

   Note what does NOT fall back here: the eur_to_pln/eur_to_gbp rates the
   international track converts with still come from the print pricing config
   alone (checkout resolves them via getPrintPricingConfigForCheckout, which
   DOES fail closed). Shipping owns no copy of them — one currency pair, one
   source, so an order's items and its shipping can never be converted at two
   different rates.

   Module-scope, in-process only — no Cloudflare binding, no persistence
   promise across isolates/deploys. Same scoping caveat as
   print-pricing-config/last-known-good.ts.
   ============================================================ */
import { DEFAULT_DOMESTIC_SHIPPING, type DomesticShippingRates } from '../pricing';
import { DEFAULT_INTERNATIONAL_SHIPPING, type InternationalShippingRates } from '../print-shipping';

/** Both tracks' live values — what one checkout prices its shipping from. */
export type ShippingRatesBundle = {
  domestic: DomesticShippingRates;
  international: InternationalShippingRates;
};

/** Tier 2: the constants the storefront has always shipped with. */
export const CODE_SHIPPING_RATES: ShippingRatesBundle = {
  domestic: DEFAULT_DOMESTIC_SHIPPING,
  international: DEFAULT_INTERNATIONAL_SHIPPING,
};

let lastGood: ShippingRatesBundle | null = null;

/** Record the result of a successful DB read as this isolate's last-known-good. */
export function recordShippingRatesSuccess(rates: ShippingRatesBundle): void {
  lastGood = rates;
}

/** Test-only: clear the isolate's last-known-good state between cases. */
export function resetLastKnownGoodForTests(): void {
  lastGood = null;
}

export type ShippingRatesFallback = {
  rates: ShippingRatesBundle;
  tier: 'last-known-good' | 'code-default';
};

/**
 * Resolve the tables getShippingRatesForCheckout() should use on a DB read
 * failure. Always returns something: see the header for why shipping, unlike
 * print pricing, must not fail the checkout closed.
 */
export function resolveShippingRatesFallback(): ShippingRatesFallback {
  if (lastGood) return { rates: lastGood, tier: 'last-known-good' };
  return { rates: CODE_SHIPPING_RATES, tier: 'code-default' };
}
