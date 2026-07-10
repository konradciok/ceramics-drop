/* Admin action: move pieces into / out of the showroom (visible but not
 * purchasable). Sets piece_state.showroom (+ showroom_entered_at / showroom_note)
 * for one or more pieces, then revalidates the `inventory` tag so the storefront
 * (collection pages, /showroom, /api/inventory) reflects the change promptly.
 * Independent of sold status — an available or a sold piece can enter showroom. */
import { NextResponse, type NextRequest } from 'next/server';
import { revalidateTag } from 'next/cache';
import { adminSupabase } from '@/lib/admin/clients';
import { registryProductById } from '@/lib/products';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { productIds?: unknown; showroom?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const productIds = Array.isArray(body.productIds)
    ? [...new Set(body.productIds.filter((s): s is string => typeof s === 'string'))]
    : [];
  const showroom = body.showroom === true;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';

  if (productIds.length === 0) {
    return NextResponse.json({ error: 'productIds required' }, { status: 400 });
  }
  const unknown = productIds.filter((id) => !registryProductById(id));
  if (unknown.length > 0) {
    return NextResponse.json({ error: `Unknown product id(s): ${unknown.join(', ')}` }, { status: 400 });
  }

  const supabase = adminSupabase();
  const { data, error } = await supabase
    .from('piece_state')
    .update({
      showroom,
      showroom_entered_at: showroom ? new Date().toISOString() : null,
      showroom_note: showroom ? (note || null) : null,
    })
    .in('product_id', productIds)
    .select('product_id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Storefront caches (getShowroomIds / getSoldIds) are tagged `inventory`.
  revalidateTag('inventory', 'max');

  const count = data?.length ?? 0;
  return NextResponse.json({
    message: showroom ? `Dodano do showroomu: ${count}.` : `Usunięto z showroomu: ${count}.`,
    count,
  });
}
