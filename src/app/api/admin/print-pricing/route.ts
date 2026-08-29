import { NextResponse } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { printPricingConfigSchema } from '@/lib/print-pricing-config/schema';
import { updatePrintPricingConfig } from '@/lib/print-pricing-config/repository';
import { actorEmail, parseJson } from '@/lib/admin/product-routes';

export const dynamic = 'force-dynamic';

/** Map thrown repository errors to HTTP responses (mirror of productError). */
function pricingError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'print_pricing_missing') {
    return NextResponse.json({ error: message }, { status: 404 });
  }
  // Keep raw DB/Supabase detail in the server log only — never leak it to the client.
  console.error('[admin/print-pricing] pricing write failed', error);
  return NextResponse.json({ error: 'pricing_write_failed' }, { status: 500 });
}

/**
 * Replace the global fine-art-print price list (single `print_pricing_config`
 * row). Gated by the Cloudflare Access JWT in worker.ts (^/api/admin). The
 * storefront reads the row via getPrintPricingConfig() in CATALOG_SOURCE=db
 * mode; `code` mode (local/test) keeps using DEFAULT_PRINT_PRICING.
 */
export async function POST(req: Request) {
  const parsed = await parseJson(req, printPricingConfigSchema);
  if (!parsed.ok) return parsed.res;
  try {
    const config = await updatePrintPricingConfig(adminSupabase(), parsed.data, actorEmail(req));
    return NextResponse.json({ config });
  } catch (err) {
    return pricingError(err);
  }
}
