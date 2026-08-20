/* Admin action: mark a piece sold (or revert a manual sale) outside the
 * checkout flow — e.g. a one-of-a-kind ceramic sold in person at a fair or
 * the studio. `sold: true` only touches pieces currently `available` (a
 * `reserved` piece is mid-checkout and must go through release-reservation
 * first). `sold: false` only reverts pieces with no `order_id` — a piece
 * actually sold online must be refunded, not flipped back here. Revalidates
 * the `inventory` tag so the storefront reflects the change promptly.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { revalidateTag } from 'next/cache';
import { adminSupabase } from '@/lib/admin/clients';
import { registryProductById } from '@/lib/products';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { productIds?: unknown; sold?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const productIds = Array.isArray(body.productIds)
    ? [...new Set(body.productIds.filter((s): s is string => typeof s === 'string'))]
    : [];
  const sold = body.sold === true;

  if (productIds.length === 0) {
    return NextResponse.json({ error: 'productIds required' }, { status: 400 });
  }
  const unknown = productIds.filter((id) => !registryProductById(id));
  if (unknown.length > 0) {
    return NextResponse.json({ error: `Unknown product id(s): ${unknown.join(', ')}` }, { status: 400 });
  }

  const supabase = adminSupabase();
  const query = supabase
    .from('piece_state')
    .update({ status: sold ? 'sold' : 'available' })
    .in('product_id', productIds);
  const { data, error } = sold
    ? await query.eq('status', 'available').select('product_id')
    : await query.eq('status', 'sold').is('order_id', null).select('product_id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Storefront caches (getShowroomIds / getSoldIds) are tagged `inventory`.
  revalidateTag('inventory', 'max');

  const count = data?.length ?? 0;
  return NextResponse.json({
    message: sold ? `Oznaczono jako sprzedane: ${count}.` : `Przywrócono dostępność: ${count}.`,
    count,
  });
}
