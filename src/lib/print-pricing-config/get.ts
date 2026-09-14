/* ============================================================
   Public accessors for the global print pricing config.
   Mirrors loadPrintCatalog (src/lib/prints.ts): CATALOG_SOURCE=code (local/
   tests) returns the code default; 'db' (production) reads the current DB
   row. The dynamic import keeps Cloudflare-only code (supabase admin
   client) out of the code-mode path and any client bundle.

   Two accessors, two different failure postures:

   - getPrintPricingConfig(): for DISPLAY only (koszyk/PDP/homepage/feed/
     sklep pages) — degrades to DEFAULT_PRINT_PRICING on a DB read failure
     so a transient hiccup never hard-fails a page render. A stale price
     shown before the buyer has paid is not a money-safety issue.
   - getPrintPricingConfigForCheckout(): for the CHECKOUT money path only
     (src/lib/checkout.ts, src/app/api/checkout/route.ts's shipping-cost
     read) — never silently substitutes DEFAULT_PRINT_PRICING; see
     last-known-good.ts for why and what it falls back to instead.
   ============================================================ */
import { catalogSource } from '../catalog/source';
import * as Sentry from '@sentry/nextjs';
import { DEFAULT_PRINT_PRICING, type PrintPricingConfig } from '../print-pricing';
import { readWithFallback } from '../supabase-timeout';
import { recordPrintPricingSuccess, resolvePrintPricingFallback } from './last-known-good';

export async function getPrintPricingConfig(): Promise<PrintPricingConfig> {
  if (catalogSource() === 'code') return DEFAULT_PRINT_PRICING;
  return readWithFallback('print-pricing-config', async () => {
    const { loadPrintPricingConfigFromDb } = await import('./load');
    return await loadPrintPricingConfigFromDb();
  }, DEFAULT_PRINT_PRICING);
}

/** Thrown by getPrintPricingConfigForCheckout() when no safe price is
 *  available to charge — a cold isolate hit by a DB outage on its first
 *  checkout of the process lifetime. Callers must fail the checkout closed
 *  (never fall back to DEFAULT_PRINT_PRICING) on this error. */
export class PrintPricingUnavailableError extends Error {
  constructor() {
    super('print_pricing_unavailable');
    this.name = 'PrintPricingUnavailableError';
  }
}

export async function getPrintPricingConfigForCheckout(): Promise<PrintPricingConfig> {
  if (catalogSource() === 'code') return DEFAULT_PRINT_PRICING;
  try {
    const { loadPrintPricingConfigFromDb } = await import('./load');
    const config = await loadPrintPricingConfigFromDb();
    recordPrintPricingSuccess(config);
    return config;
  } catch (err) {
    const { config, tier } = resolvePrintPricingFallback();
    console.error('[print-pricing-config] DB read failed (checkout); using fallback', { fallbackTier: tier }, err);
    // fallbackTier as a tag (not `extra`) so the two tiers are filterable in
    // Sentry, distinct from a generic Supabase hiccup — same convention as
    // catalog/last-known-good.ts's ceramic-catalog fallback reporting.
    Sentry.captureException(err, { tags: { supabaseTimeoutLabel: 'print-pricing-config-checkout', fallbackTier: tier } });
    if (!config) throw new PrintPricingUnavailableError();
    return config;
  }
}
