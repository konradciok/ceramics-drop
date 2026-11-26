import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getClientIp } from '@/lib/client-ip';
import { createCheckoutRateLimiter } from '@/lib/checkout-rate-limit';
import { cancelPaymentIntent, claimExpiryLease, finalizeExpiry, releaseExpiryLease } from '@/lib/expire-orders';
import { editCheckout, type EditableOrder } from '@/server/checkout-edit';

export const dynamic = 'force-dynamic';

/** The new attempt's hold, the same 15 minutes as a checkout's. */
const RESERVE_TTL_SECS = 900;
const editRateLimiter = createCheckoutRateLimiter();
// x-forwarded-for is spoofable off-Cloudflare, so only trust it outside production.
const TRUST_FORWARDED_IP = process.env.NODE_ENV !== 'production';

/**
 * POST /api/checkout/edit — "Zmień" on the cart's payment step. Body:
 * `{ orderId, clientSecret, nextAttemptId }`. See src/server/checkout-edit.ts.
 */
export async function POST(req: Request) {
  const clientIp = getClientIp(req, { trustForwarded: TRUST_FORWARDED_IP })?.trim() || null;
  const rate = editRateLimiter.allow(clientIp ?? (TRUST_FORWARDED_IP ? null : 'unknown'));
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const stripe = getStripe();
  try {
    const result = await editCheckout(body, {
      loadOrder: async (orderId) => {
        const { data, error } = await supabase
          .from('orders')
          .select('id, status, payment_intent_id, private_sale_id, gift_card_id, promo_code')
          .eq('id', orderId)
          .maybeSingle();
        if (error) throw new Error(`order lookup failed: ${error.message}`);
        return (data as EditableOrder | null) ?? null;
      },
      retrieveIntent: async (paymentIntentId) => {
        try {
          const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
          return { clientSecret: intent.client_secret, orderId: intent.metadata?.order_id ?? null, status: intent.status };
        } catch (err) {
          // Only "no such PaymentIntent" reads as a wrong secret (403); a
          // timeout or API outage throws → 503 + Sentry in editCheckout.
          if ((err as { code?: unknown } | null)?.code === 'resource_missing') return null;
          throw err;
        }
      },
      claimLease: (orderId) => claimExpiryLease(supabase, orderId),
      releaseLease: (orderId, token) => releaseExpiryLease(supabase, orderId, token),
      transferHold: async (orderId, attemptId) => {
        const { data, error } = await supabase.rpc('transfer_reservation', {
          p_from: orderId,
          p_to: attemptId,
          p_ttl_secs: RESERVE_TTL_SECS,
        });
        if (error) throw new Error(error.message);
        return typeof data === 'number' ? data : 0;
      },
      restoreHold: async (attemptId, orderId) => {
        const { data, error } = await supabase.rpc('restore_transferred_reservation', {
          p_attempt: attemptId,
          p_order: orderId,
          p_ttl_secs: RESERVE_TTL_SECS,
        });
        if (error) throw new Error(error.message);
        return typeof data === 'number' ? data : 0;
      },
      cancelIntent: (paymentIntentId) => cancelPaymentIntent(stripe, paymentIntentId),
      finalize: async (order, token) => {
        await finalizeExpiry(supabase, order, token);
      },
      log: (event, meta) => {
        console.error(JSON.stringify({ event, ...meta }));
        Sentry.captureMessage(event, { level: 'error', extra: meta });
      },
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    console.error('checkout edit failed', err);
    Sentry.captureException(err);
    return NextResponse.json({ error: 'edit_failed' }, { status: 503 });
  }
}
