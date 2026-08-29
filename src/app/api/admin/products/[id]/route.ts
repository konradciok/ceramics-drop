import { NextResponse } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { updateProductMeta } from '@/lib/catalog/repository';
import { productUpdateSchema } from '@/lib/catalog/schemas';
import { actorEmail, parseJson, productError } from '@/lib/admin/product-routes';

export const dynamic = 'force-dynamic';

/**
 * Patch a product's editable metadata (num/price_pln/measure/seo/slug).
 * Gated by the Cloudflare Access JWT in worker.ts (^/api/admin). Only affects
 * the storefront in CATALOG_SOURCE=db mode; the code registry is unaffected.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseJson(req, productUpdateSchema);
  if (!parsed.ok) return parsed.res;
  try {
    const product = await updateProductMeta(adminSupabase(), id, parsed.data, actorEmail(req));
    return NextResponse.json({ product });
  } catch (err) {
    return productError(err);
  }
}
