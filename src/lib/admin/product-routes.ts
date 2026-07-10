/* ============================================================
   Admin product route helpers (Stage 4a)
   ------------------------------------------------------------
   Thin layer over the shared admin route helpers: reuse the generic Zod
   `parseJson` and trusted `actorEmail` (worker-set header) from content-routes,
   and add a product-specific error mapper mirroring `contentError`.
   ============================================================ */
import { NextResponse } from 'next/server';
import { revalidateTag, revalidatePath } from 'next/cache';

export { actorEmail, parseJson } from './content-routes';

/**
 * Bust the storefront catalogue cache after a product write. `catalog` is the
 * tag the cached DB loaders use (src/lib/catalog/load.ts); the feed routes are
 * path-revalidated too (matching content/publish). Collection/PDP pages are
 * force-dynamic, so they need no path revalidation.
 */
export function revalidateCatalog(): void {
  revalidateTag('catalog', 'max');
  revalidatePath('/api/feed/google');
  revalidatePath('/api/feed/meta');
}

/** Map thrown repository errors to HTTP responses (mirror of contentError). */
export function productError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'product_not_found') {
    return NextResponse.json({ error: message }, { status: 404 });
  }
  if (message === 'slug_taken') {
    return NextResponse.json({ error: message }, { status: 409 });
  }
  // Keep raw DB/Supabase detail in the server log only — never leak it to the client.
  console.error('[admin/products] catalog write failed', error);
  return NextResponse.json({ error: 'catalog_write_failed' }, { status: 500 });
}
