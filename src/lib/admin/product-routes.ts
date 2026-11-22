/* ============================================================
   Admin product route helpers (Stage 4a)
   ------------------------------------------------------------
   Thin layer over the shared admin route helpers: reuse the generic Zod
   `parseJson` and trusted `actorEmail` (worker-set header) from content-routes,
   and add a product-specific error mapper mirroring `contentError`.
   ============================================================ */
import { NextResponse } from 'next/server';

export { actorEmail, parseJson } from './content-routes';

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
