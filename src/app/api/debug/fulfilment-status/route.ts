import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getSupabaseAdmin } from '@/lib/supabase';
import { timingSafeEqual } from '@/lib/timing-safe-equal';

export const dynamic = 'force-dynamic';

/**
 * Fail-closed debug read for the destructive print-purchase E2E (audit H-2).
 * Returns the minimal fulfilment state needed to assert the
 * Stripe→webhook→queue→Prodigi path actually advanced after a paid sandbox
 * order — so a regression (job never enqueued / never submitted) fails the spec
 * instead of passing on a bare success-page assertion.
 *
 * Gating:
 *   - no FULFILMENT_DEBUG_TOKEN in env → 404 (route is effectively absent in any
 *     environment that didn't opt in — e.g. production never sets it).
 *   - token set but the x-fulfilment-debug-token header is missing/mismatched → 401.
 *
 * Lookup is by Stripe PaymentIntent id (what the test derives from the
 * /api/checkout client_secret / the return-page URL). Returns
 * { fulfilmentStatus, prodigiOrderId } — both null until the order row and/or
 * job land, so a poll keeps going. No PII, no payment info.
 */
export async function GET(req: Request) {
  const { env } = getCloudflareContext();
  const expected = env.FULFILMENT_DEBUG_TOKEN;
  if (!expected) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const provided = req.headers.get('x-fulfilment-debug-token');
  if (!provided || !timingSafeEqual(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const paymentIntentId = new URL(req.url).searchParams.get('payment_intent');
  if (!paymentIntentId || !paymentIntentId.startsWith('pi_')) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('id')
    .eq('payment_intent_id', paymentIntentId)
    .maybeSingle();
  if (orderErr) return NextResponse.json({ error: 'lookup_failed' }, { status: 500 });
  // No order row yet (webhook hasn't persisted) — keep polling.
  if (!order) return NextResponse.json({ fulfilmentStatus: null, prodigiOrderId: null });

  const [jobsRes, prodigiRes] = await Promise.all([
    supabase.from('fulfilment_jobs').select('status').eq('order_id', order.id).maybeSingle(),
    supabase.from('prodigi_orders').select('prodigi_order_id').eq('order_id', order.id),
  ]);
  if (jobsRes.error || prodigiRes.error) {
    return NextResponse.json({ error: 'lookup_failed' }, { status: 500 });
  }
  const prodigiRows = (prodigiRes.data as { prodigi_order_id: string | null }[] | null) ?? [];
  const prodigiOrderId = prodigiRows.find((r) => r.prodigi_order_id)?.prodigi_order_id ?? null;

  return NextResponse.json({
    fulfilmentStatus: (jobsRes.data as { status: string | null } | null)?.status ?? null,
    prodigiOrderId,
  });
}
