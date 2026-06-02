import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { validateCart } from '@/lib/checkout';
import { orderAmountGrosze, type ShipMethod } from '@/lib/pricing';

export const dynamic = 'force-dynamic';

const RESERVE_TTL_SECS = 900; // 15-minute hold

export async function POST(req: Request) {
  let body: { ids?: unknown; shipping_method?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const valid = validateCart(body.ids);
  if (!valid.ok) return NextResponse.json({ error: valid.reason }, { status: 400 });

  const method: ShipMethod = body.shipping_method === 'odbior' ? 'odbior' : 'kurier';
  const amount = orderAmountGrosze(valid.items.map((i) => i.unit_price), method);
  const ids = valid.items.map((i) => i.product_id);

  const supabase = getSupabaseAdmin();
  const orderId = crypto.randomUUID();

  // Reserve atomically BEFORE creating the PaymentIntent.
  const { data: conflicts, error: reserveErr } = await supabase.rpc('reserve_pieces', {
    p_ids: ids,
    p_order_id: orderId,
    p_ttl_secs: RESERVE_TTL_SECS,
  });
  if (reserveErr) return NextResponse.json({ error: 'reserve_failed' }, { status: 500 });
  if (Array.isArray(conflicts) && conflicts.length > 0) {
    return NextResponse.json({ error: 'unavailable', sold: conflicts }, { status: 409 });
  }

  const stripe = getStripe();
  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'pln',
      automatic_payment_methods: { enabled: true },
      metadata: { order_id: orderId, product_ids: ids.join(','), shipping_method: method },
    });
  } catch {
    // Release the hold if Stripe failed, so pieces don't get stuck reserved.
    await supabase.rpc('reserve_pieces', { p_ids: [], p_order_id: orderId, p_ttl_secs: 0 });
    await supabase.from('piece_state').update({ status: 'available', reserved_until: null, order_id: null })
      .eq('order_id', orderId);
    return NextResponse.json({ error: 'stripe_failed' }, { status: 502 });
  }

  const subtotal = valid.items.reduce((s, i) => s + i.unit_price, 0);
  await supabase.from('orders').insert({
    id: orderId,
    payment_intent_id: paymentIntent.id,
    status: 'pending',
    currency: 'pln',
    subtotal,
    shipping: amount - subtotal,
    total: amount,
    shipping_method: method,
  });
  await supabase.from('order_items').insert(
    valid.items.map((i) => ({ order_id: orderId, product_id: i.product_id, unit_price: i.unit_price })),
  );

  return NextResponse.json({ client_secret: paymentIntent.client_secret });
}
