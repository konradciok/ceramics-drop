import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { handleStripeEvent } from '@/lib/webhook';
import { createOrderInvoice } from '@/lib/invoice';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'no_signature' }, { status: 400 });

  const body = await req.text();
  const stripe = getStripe();
  const { env } = getCloudflareContext();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  await handleStripeEvent(event, {
    markPaid: async (pi) => {
      // Only the first 'pending'→'paid' transition returns a row (idempotency).
      const { data } = await supabase
        .from('orders')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id');
      const rows = data as Array<{ id: string }> | null;
      if (!rows || rows.length === 0) return false;
      const orderId = rows[0].id;
      await supabase
        .from('piece_state')
        .update({ status: 'sold', reserved_until: null })
        .eq('order_id', orderId);
      return true;
    },
    releaseHold: async (pi) => {
      const { data } = await supabase
        .from('orders')
        .update({ status: 'failed' })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id');
      const rows = data as Array<{ id: string }> | null;
      if (rows && rows.length > 0) {
        await supabase
          .from('piece_state')
          .update({ status: 'available', reserved_until: null, order_id: null })
          .eq('order_id', rows[0].id);
      }
    },
    createInvoice: (pi) => createOrderInvoice(pi),
    revalidate: (tag) => revalidateTag(tag, 'max'),
  });

  return NextResponse.json({ received: true });
}
