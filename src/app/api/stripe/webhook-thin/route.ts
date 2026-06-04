import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getStripe } from '@/lib/stripe';

export const dynamic = 'force-dynamic';

/**
 * Thin event destination (Stripe Event Destinations). Fulfillment stays on the
 * snapshot handler at /api/stripe/webhook; this route only verifies signatures
 * and ACKs so Stripe does not retry while thin migration is in shadow mode.
 */
export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'no_signature' }, { status: 400 });

  const body = await req.text();
  const stripe = getStripe();
  const { env } = getCloudflareContext();

  try {
    await stripe.parseEventNotificationAsync(body, sig, env.STRIPE_WEBHOOK_THIN_SECRET);
  } catch {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 });
  }

  return NextResponse.json({ received: true });
}
