/* LOCAL-ONLY admin action: issue a Stripe refund for a paid order.
 * Creates a FULL refund only (no `amount`) — the existing `charge.refunded`
 * webhook handler only relists pieces on a full refund, so a partial refund
 * here would move money without relisting the piece. The webhook + page refresh
 * reflect the resulting state. */
import { NextResponse, type NextRequest } from 'next/server';
import { adminSupabase, adminStripe } from '@/lib/admin/clients';
import { parseOrderIdBody } from '@/lib/admin/route-helpers';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const parsed = await parseOrderIdBody(req);
  if (!parsed.ok) return parsed.res;
  const { orderId } = parsed;

  const supabase = adminSupabase();
  const { data, error } = await supabase
    .from('orders')
    .select('payment_intent_id, status')
    .eq('id', orderId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (data.status !== 'paid') {
    return NextResponse.json({ error: `Nie można zwrócić zamówienia o statusie „${data.status}”.` }, { status: 409 });
  }
  if (!data.payment_intent_id) {
    return NextResponse.json({ error: 'Brak PaymentIntent dla zamówienia.' }, { status: 409 });
  }

  try {
    const refund = await adminStripe().refunds.create({ payment_intent: data.payment_intent_id });
    return NextResponse.json({ message: `Zwrot utworzony (${refund.id}). Status zaktualizuje webhook.` });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Stripe refund failed' }, { status: 502 });
  }
}
