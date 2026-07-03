import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { validateCart } from '@/lib/checkout';
import { loadActivePrivateSale, normalizeToken, INVALID_TOKEN_SENTINEL } from '@/lib/private-sale';
import { releaseTargetStatus } from '@/lib/piece-release';
import { validateDelivery } from '@/lib/shipx';
import { orderAmountGrosze, orderAmountEuroCents, orderAmountGBPPence } from '@/lib/pricing';
import { getClientIp } from '@/lib/client-ip';
import { createCheckoutRateLimiter } from '@/lib/checkout-rate-limit';
import { readConsent } from '@/components/consent/consent-mode';
import { SITE_URL } from '@/lib/site';
import { sendCheckoutStartedEvent } from '@/lib/resend-events';
import type { MarketingContext } from '@/lib/marketing/context';

export const dynamic = 'force-dynamic';

const RESERVE_TTL_SECS = 900; // 15-minute hold
const STRIPE_PMC_ID = 'pmc_1QiwdYJ0KFK9lrjHUV93dONs';
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
  const VALID_LOCALES = ['pl', 'en', 'es', 'de', 'gb'] as const;
  const locale: string =
    typeof body.locale === 'string' && (VALID_LOCALES as readonly string[]).includes(body.locale)
      ? body.locale
      : 'pl';
  const currency: 'pln' | 'eur' | 'gbp' =
    locale === 'pl' ? 'pln' : locale === 'gb' ? 'gbp' : 'eur';

  const valid = validateCart(body.ids, currency);
  if (!valid.ok) return NextResponse.json({ error: valid.reason }, { status: 400 });

  // Delivery details (method, receiver contact, locker/address) are collected
  // pre-payment so InPost has everything it needs once the order is paid.
  const delivery = validateDelivery(body);
  if (!delivery.ok) return NextResponse.json({ error: delivery.reason }, { status: 400 });
  const { method, contact, target_point, address } = delivery.delivery;

  const unitPrices = valid.items.map((i) => i.unit_price);
  const amount =
    currency === 'eur' ? orderAmountEuroCents(unitPrices, method) :
    currency === 'gbp' ? orderAmountGBPPence(unitPrices, method) :
    orderAmountGrosze(unitPrices, method);
  const ids = valid.items.map((i) => i.product_id);
  // Only ceramics carry a piece_state row to reserve; prints are open-edition.
  const ceramicIds = valid.items.filter((i) => !i.variant).map((i) => i.product_id);
  const hasPrints = valid.items.some((i) => i.variant);

  // Prints are fulfilled by Prodigi to a home address — a locker or studio pickup
  // leaves shipping_address NULL and the Prodigi order could never be built.
  if (hasPrints && method !== 'kurier') {
    return NextResponse.json({ error: 'invalid_delivery' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const orderId = crypto.randomUUID();

  // A private-sale token unlocks buying specific already-`sold` pieces via a secret
  // link, without relisting them in the shop. It uses a dedicated atomic RPC that
  // requires the cart to exactly match the link's bundle; normal carts reserve as usual.
  const privateSaleToken = normalizeToken(body.private_sale_token);
  let privateSaleId: string | null = null;

  // Reserve atomically BEFORE creating the PaymentIntent.
  if (privateSaleToken) {
    const sale = await loadActivePrivateSale(supabase, privateSaleToken);
    if (!sale) return NextResponse.json({ error: 'private_sale_invalid' }, { status: 410 });
    privateSaleId = sale.id;
    const { data: psConflicts, error: psErr } = await supabase.rpc('reserve_private_sale_pieces', {
      p_token: privateSaleToken,
      p_ids: ids,
      p_order_id: orderId,
      p_ttl_secs: RESERVE_TTL_SECS,
    });
    if (psErr) return NextResponse.json({ error: 'reserve_failed' }, { status: 500 });
    const conflictArr = Array.isArray(psConflicts) ? (psConflicts as string[]) : [];
    if (conflictArr.includes(INVALID_TOKEN_SENTINEL)) {
      return NextResponse.json({ error: 'private_sale_invalid' }, { status: 410 });
    }
    if (conflictArr.length > 0) {
      return NextResponse.json({ error: 'unavailable', sold: conflictArr }, { status: 409 });
    }
  } else if (ceramicIds.length > 0) {
    const { data: conflicts, error: reserveErr } = await supabase.rpc('reserve_pieces', {
      p_ids: ceramicIds,
      p_order_id: orderId,
      p_ttl_secs: RESERVE_TTL_SECS,
    });
    if (reserveErr) return NextResponse.json({ error: 'reserve_failed' }, { status: 500 });
    if (Array.isArray(conflicts) && conflicts.length > 0) {
      return NextResponse.json({ error: 'unavailable', sold: conflicts }, { status: 409 });
    }
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
      payment_method_configuration: STRIPE_PMC_ID,
      metadata: {
        order_id: orderId,
        product_ids: ids.join(','),
        delivery_method: method,
        ...(privateSaleId ? { private_sale_id: privateSaleId } : {}),
        ...(hasPrints ? { has_prints: '1' } : {}),
      },
    });
  } catch {
    // Release the hold if Stripe failed, so pieces don't get stuck reserved.
    // Private-sale holds return to `sold` (never relisted publicly); normal holds free up.
    await supabase.from('piece_state')
      .update({ status: releaseTargetStatus({ private_sale_id: privateSaleId }), reserved_until: null, order_id: null })
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
  const eventSourceUrl = `${origin || SITE_URL}${localePrefix}/koszyk/return`;
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
    private_sale_id: privateSaleId,
  });
  let itemsErr = null;
  if (!orderErr) {
    const r = await supabase.from('order_items').insert(
      valid.items.map((i) => ({
        order_id: orderId,
        product_id: i.product_id,
        unit_price: i.unit_price,
        variant: i.variant ? { kind: 'print' as const, ...i.variant } : null,
      })),
    );
    itemsErr = r.error;
  }
  if (orderErr || itemsErr) {
    // Persisting the order failed ÔÇö undo so we never collect money without a record.
    try { await stripe.paymentIntents.cancel(paymentIntent.id); } catch {}
    // Private-sale holds return to `sold` (never relisted publicly); normal holds free up.
    await supabase.from('piece_state')
      .update({ status: releaseTargetStatus({ private_sale_id: privateSaleId }), reserved_until: null, order_id: null })
      .eq('order_id', orderId);
    return NextResponse.json({ error: 'order_persist_failed' }, { status: 500 });
  }

  // Kick off the abandoned-checkout recovery flow (Resend Automation triggered by
  // cart.checkout_started). Best-effort and non-blocking: waitUntil lets it finish
  // after the response so it adds no latency to the pay request, and any Resend
  // failure is logged — never fails checkout.
  try {
    const { ctx } = getCloudflareContext();
    ctx.waitUntil(
      sendCheckoutStartedEvent({
        orderId,
        email: contact.email,
        locale,
        currency,
        totalMinor: amount,
        firstName: contact.first_name,
        origin,
      }).catch((err) => console.error('sendCheckoutStartedEvent failed for', orderId, err)),
    );
  } catch (err) {
    console.error('sendCheckoutStartedEvent dispatch failed for', orderId, err);
  }

  return NextResponse.json({ client_secret: paymentIntent.client_secret });
}
