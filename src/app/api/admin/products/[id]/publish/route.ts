import { NextResponse } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { updateProductStatus } from '@/lib/catalog/repository';
import { productStatusSchema } from '@/lib/catalog/schemas';
import { actorEmail, parseJson, productError } from '@/lib/admin/product-routes';

export const dynamic = 'force-dynamic';

/**
 * Transition a product's publish status (draft/active/hidden/archived).
 * Archiving is a soft-archive (status only). Only affects the storefront in
 * CATALOG_SOURCE=db mode — a non-active status withdraws the product from every
 * public surface via isProductPublic (products.ts).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseJson(req, productStatusSchema);
  if (!parsed.ok) return parsed.res;
  try {
    const product = await updateProductStatus(adminSupabase(), id, parsed.data.status, actorEmail(req));
    return NextResponse.json({ product });
  } catch (err) {
    return productError(err);
  }
}
