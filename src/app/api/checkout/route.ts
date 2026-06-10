import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { validateCart } from '@/lib/checkout';
import { validateDelivery } from '@/lib/shipx';
import { orderAmountGrosze, orderAmountEuroCents } from '@/lib/pricing';
import { getClientIp } from '@/lib/client-ip';
import { createCheckoutRateLimiter } from '@/lib/checkout-rate-limit';
import { readConsent } from '@/components/consent/consent-mode';
import type { MarketingContext } from '@/lib/marketing/context';

export const dynamic = 'force-dynamic';

const RESERVE_TTL_SECS = 900; // 15-minute hold
const checkoutRateLimiter = createCheckoutRateLimiter();
// x-forwarded-for is spoofable off-Cloudflare, so only trust it outside production.
const TRUST_FORWARDED_IP = process.env.NODE_ENV !== 'production';

export async function POST(req: Request) {
  // Throttle before any reservation / Stripe work. In prod a missing IP shares one
  // "unknown" bucket instead of bypassing the limiter; in dev we fail open.
  const clientIp = getClientIp(req, { trustForwarded: TRUST_FORWARDED_IP })?.trim() || null;
  const rateKey = clientIp ?? (TRUST_FORWARDED_IP ? null : 'unknown');
  const rate = checkoutRateLimiter.allow(rateKey);
  if (!rate.ok) {
    console.warn('checkout: rate_limited', { hasIp: Boolean(clientIp) });
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  // Loosely typed: validateCart / validateDelivery narrow the fields at runtime.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  // Persist the buyer's locale so the shipping-confirmation email can be localised.
  const VALID_LOCALES = ['pl', 'en', 'es'] as const;
  const locale: string =
    typeof body.locale === 'string' && (VALID_LOCALES as readonly string[]).includes(body.locale)
      ? body.locale
      : 'pl';
  const currency: 'pln' | 'eur' = locale === 'pl' ? 'pln' : 'eur';

  const valid = validateCart(body.ids, currency);
  if (!valid.ok) return NextResponse.json({ error: valid.reason }, { status: 400 });

  // Delivery details (method, receiver contact, locker/address) are collected
  // pre-payment so InPost has everything it needs once the order is paid.
  const delivery = validateDelivery(body);
  if (!delivery.ok) return NextResponse.json({ error: delivery.reason }, { status: 400 });
  const { method, contact, target_point, address } = delivery.delivery;

  const amount = currency === 'eur'
    ? orderAmountEuroCents(valid.items.map((i) => i.unit_price), method)
    : orderAmountGrosze(valid.items.map((i) => i.unit_price), method);
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
    // No receipt_email here: the paid order is emailed a faktura via
    // createOrderInvoice (Stripe sendInvoice), so setting receipt_email would
    // risk a second, duplicate Stripe receipt.
    paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: { order_id: orderId, product_ids: ids.join(','), delivery_method: method },
    });
  } catch {
    // Release the hold if Stripe failed, so pieces don't get stuck reserved.
    await supabase.from('piece_state').update({ status: 'available', reserved_until: null, order_id: null })
      .eq('order_id', orderId);
    return NextResponse.json({ error: 'stripe_failed' }, { status: 502 });
  }

  const cookieHeader = req.headers.get('cookie') ?? '';
  const consent = readConsent(cookieHeader) === 'granted' ? 'granted' : 'denied';
  const mc = (body.marketing_cookies ?? {}) as Record<string, unknown>;
  const str2 = (v: unknown, max = 256) => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || s.length > max) return null;
    return s;
  };
  const origin = req.headers.get('origin') ?? '';
  const localePrefix = locale !== 'pl' ? `/${locale}` : '';
  const eventSourceUrl = origin ? `${origin}${localePrefix}/koszyk/return` : null;
  const marketing: MarketingContext = {
    consent,
    fbp: str2(mc.fbp),
    fbc: str2(mc.fbc),
    ga_client_id: str2(mc.ga_client_id),
    ga_session_id: str2(mc.ga_session_id),
    ip: clientIp,
    user_agent: req.headers.get('user-agent'),
    event_source_url: eventSourceUrl,
    captured_at: new Date().toISOString(),
  };

  const subtotal = valid.items.reduce((s, i) => s + i.unit_price, 0);
  const { error: orderErr } = await supabase.from('orders').insert({
    id: orderId,
    payment_intent_id: paymentIntent.id,
    status: 'pending',
    currency,
    subtotal,
    shipping: amount - subtotal,
    total: amount,
    shipping_method: method, // legacy NOT NULL column ÔÇö kept in sync with delivery_method
    delivery_method: method,
    email: contact.email,
    receiver_first_name: contact.first_name,
    receiver_last_name: contact.last_name,
    receiver_phone: contact.phone || null,
    inpost_target_point: target_point ?? null,
    shipping_address: address ?? null,
    locale,
    marketing,
  });
  let itemsErr = null;
  if (!orderErr) {
    const r = await supabase.from('order_items').insert(
      valid.items.map((i) => ({ order_id: orderId, product_id: i.product_id, unit_price: i.unit_price })),
    );
    itemsErr = r.error;
  }
  if (orderErr || itemsErr) {
    // Persisting the order failed ÔÇö undo so we never collect money without a record.
    try { await stripe.paymentIntents.cancel(paymentIntent.id); } catch {}
    await supabase.from('piece_state')
      .update({ status: 'available', reserved_until: null, order_id: null })
      .eq('order_id', orderId);
    return NextResponse.json({ error: 'order_persist_failed' }, { status: 500 });
  }

  return NextResponse.json({ client_secret: paymentIntent.client_secret });
}
