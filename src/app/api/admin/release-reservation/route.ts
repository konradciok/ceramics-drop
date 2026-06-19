/* Admin action: free pieces stuck in `reserved` for an order (e.g. an abandoned
 * checkout whose hold never expired), relisting them as available. Cancels the
 * PaymentIntent first when the order is still pending — mirrors
 * `expireAbandonedOrders` cancel-then-release ordering. */
import { NextResponse, type NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { adminSupabase, adminStripe } from '@/lib/admin/clients';
import { parseOrderIdBody } from '@/lib/admin/route-helpers';
import type { CancelOutcome } from '@/lib/expire-orders';
import { releaseTargetStatus } from '@/lib/piece-release';

export const dynamic = 'force-dynamic';

async function cancelIntent(stripe: Stripe, pi: string): Promise<CancelOutcome> {
  try {
    await stripe.paymentIntents.cancel(pi);
    return 'canceled';
  } catch {
    try {
      const intent = await stripe.paymentIntents.retrieve(pi);
      if (intent.status === 'canceled') return 'canceled';
      if (intent.status === 'succeeded' || intent.status === 'processing' || intent.status === 'requires_capture') {
        return 'paid';
      }
      return 'error';
    } catch {
      return 'error';
    }
  }
}

export async function POST(req: NextRequest) {
  const parsed = await parseOrderIdBody(req);
  if (!parsed.ok) return parsed.res;
  const { orderId } = parsed;

  const supabase = adminSupabase();
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('status, private_sale_id, payment_intent_id')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr) return NextResponse.json({ error: orderErr.message }, { status: 500 });
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (order.status === 'paid') {
    return NextResponse.json({ error: 'Zamówienie opłacone — użyj zwrotu, nie zwalniaj rezerwacji.' }, { status: 409 });
  }

  if (order.status === 'pending' && order.payment_intent_id) {
    const outcome = await cancelIntent(adminStripe(), order.payment_intent_id);
    if (outcome === 'paid') {
      return NextResponse.json(
        { error: 'Płatność w toku lub zakończona — nie można zwolnić rezerwacji.' },
        { status: 409 },
      );
    }
    if (outcome === 'error') {
      return NextResponse.json({ error: 'Nie udało się anulować PaymentIntent w Stripe.' }, { status: 502 });
    }
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
  if (count > 0 && order.status === 'pending') {
    const { error: expireErr } = await supabase
      .from('orders')
      .update({ status: 'expired' })
      .eq('id', orderId)
      .eq('status', 'pending');
    if (expireErr) return NextResponse.json({ error: expireErr.message }, { status: 500 });
  }

  return NextResponse.json({ message: count ? `Zwolniono ${count} prac(e).` : 'Brak zarezerwowanych prac do zwolnienia.' });
}
