/* LOCAL-ONLY admin action: free pieces stuck in `reserved` for an order (e.g.
 * an abandoned checkout whose hold never expired), relisting them as available.
 * Mirrors the webhook `releaseHold` logic, scoped to a single order. */
import { NextResponse, type NextRequest } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { parseOrderIdBody } from '@/lib/admin/route-helpers';
import { releaseTargetStatus } from '@/lib/piece-release';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const parsed = await parseOrderIdBody(req);
  if (!parsed.ok) return parsed.res;
  const { orderId } = parsed;

  const supabase = adminSupabase();
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('status, private_sale_id')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr) return NextResponse.json({ error: orderErr.message }, { status: 500 });
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (order.status === 'paid') {
    return NextResponse.json({ error: 'Zamówienie opłacone — użyj zwrotu, nie zwalniaj rezerwacji.' }, { status: 409 });
  }

  // Private-sale pieces return to `sold` (never relisted publicly); normal holds relist as available.
  const { data: freed, error } = await supabase
    .from('piece_state')
    .update({ status: releaseTargetStatus(order), order_id: null, reserved_until: null })
    .eq('order_id', orderId)
    .eq('status', 'reserved')
    .select('product_id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const count = freed?.length ?? 0;
  // Only mark the order abandoned when we actually freed a stuck reservation —
  // otherwise leave its status untouched (don't silently expire an order with
  // nothing to release).
  if (count > 0 && order.status === 'pending') {
    await supabase.from('orders').update({ status: 'expired' }).eq('id', orderId).eq('status', 'pending');
  }

  return NextResponse.json({ message: count ? `Zwolniono ${count} prac(e).` : 'Brak zarezerwowanych prac do zwolnienia.' });
}
