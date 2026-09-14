/* ============================================================
   Print pricing last-known-good — isolate-lifetime checkout fallback
   ------------------------------------------------------------
   getPrintPricingConfigForCheckout() (get.ts) consults this on a DB read
   failure. Unlike the ceramic catalog (catalog/last-known-good.ts), pricing
   has no per-row `status` to fail closed *into* — there's nothing to mark
   'hidden'. So a cold isolate (no prior successful read) has no safe value
   to fall back to at all: it must block the purchase outright rather than
   silently charge a stale hardcoded default (DEFAULT_PRINT_PRICING), which
   is exactly the failure mode this module exists to close off. A warm
   isolate that has served at least one successful read degrades to that
   real, previously-observed DB config instead.

   getPrintPricingConfig() (the display-only accessor used by koszyk/PDP/
   homepage/feed/sklep pages) deliberately does NOT consult this — a stale
   price shown before the buyer has paid is not a money-safety issue, and
   keeping it on the existing DEFAULT_PRINT_PRICING fallback avoids a page
   render hard-failing over a transient DB hiccup.

   Module-scope, in-process only — no Cloudflare binding, no persistence
   promise across isolates/deploys. Same scoping caveat as
   catalog/last-known-good.ts.
   ============================================================ */
import type { PrintPricingConfig } from '../print-pricing';

let lastGood: PrintPricingConfig | null = null;

/** Record the result of a successful DB read as this isolate's last-known-good. */
export function recordPrintPricingSuccess(config: PrintPricingConfig): void {
  lastGood = config;
}

/** Test-only: clear the isolate's last-known-good state between cases. */
export function resetLastKnownGoodForTests(): void {
  lastGood = null;
}

export type FallbackResult =
  | { config: PrintPricingConfig; tier: 'last-known-good' }
  | { config: null; tier: 'cold-fail-closed' };

/**
 * Resolve the value getPrintPricingConfigForCheckout() should use on a DB
 * read failure: this isolate's last-known-good config if it has served one,
 * otherwise `config: null` so the caller can fail the checkout closed.
 */
export function resolvePrintPricingFallback(): FallbackResult {
  if (lastGood) return { config: lastGood, tier: 'last-known-good' };
  return { config: null, tier: 'cold-fail-closed' };
}
