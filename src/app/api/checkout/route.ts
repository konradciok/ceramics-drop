import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { validateCart } from '@/lib/checkout';
import { currencyFromCookieHeader, toChargeableCurrency } from '@/lib/currency';
import { loadActivePrivateSale, normalizeToken, INVALID_TOKEN_SENTINEL } from '@/lib/private-sale';
import { releaseReservedPieces } from '@/lib/piece-release';
import { validateDelivery } from '@/lib/shipx';
import { orderAmountGrosze, orderAmountEuroCents, orderAmountGBPPence, toEuroCents, toGBPPence, toGrosze } from '@/lib/pricing';
import { isPrintCountry, printShippingOf, type PrintCountry } from '@/lib/print-shipping';
import { getClientIp } from '@/lib/client-ip';
import { createCheckoutRateLimiter } from '@/lib/checkout-rate-limit';
import { readConsent } from '@/components/consent/consent-mode';
import { SITE_URL } from '@/lib/site';
import { sendCheckoutStartedEvent } from '@/lib/resend-events';
import type { MarketingContext } from '@/lib/marketing/context';

export const dynamic = 'force-dynamic';

const RESERVE_TTL_SECS = 900; // 15-minute hold
const STRIPE_PMC_ID = 'pmc_1QiwdYJ0KFK9lrjHUV93dONs';
// Canonical 8-4-4-4-12 hex UUID shape (any version). A client-supplied id only
// becomes the order id once it passes this trust-boundary check — see below.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_UNIQUE_VIOLATION = '23505';
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
  const VALID_LOCALES = ['pl', 'en', 'es', 'de'] as const;
  const locale: string =
    typeof body.locale === 'string' && (VALID_LOCALES as readonly string[]).includes(body.locale)
      ? body.locale
      : 'pl';
  // Currency is a per-request concern driven by the `currency_pref` cookie, not
  // the locale. Clamp to the launched, sellable currencies — USD/CAD are wired
  // through pricing but have no Stripe branch here yet.
  const chargeCurrency = toChargeableCurrency(
    currencyFromCookieHeader(locale, req.headers.get('cookie')),
  );

  const valid = await validateCart(body.ids, chargeCurrency);
  if (!valid.ok) {
    const status = valid.reason === 'print_asset_unavailable' ? 409 : 400;
    return NextResponse.json({ error: valid.reason }, { status });
  }

  // Delivery details (method, receiver contact, locker/address) are collected
  // pre-payment so InPost has everything it needs once the order is paid.
  const delivery = validateDelivery(body);
  if (!delivery.ok) return NextResponse.json({ error: delivery.reason }, { status: 400 });
  const { method, contact, target_point, address } = delivery.delivery;

  const ids = valid.items.map((i) => i.product_id);
  // Only ceramics carry a piece_state row to reserve; prints are open-edition.
  // validateCart guarantees a cart is all-ceramic or all-print (no mixing).
  const ceramicIds = valid.items.filter((i) => !i.variant).map((i) => i.product_id);
  const hasPrints = valid.items.some((i) => i.variant);
  const fulfilmentType = method === 'odbior' ? 'pickup' : hasPrints ? 'prodigi' : 'inpost';

  // Prints are fulfilled by Prodigi to a home address — a locker or studio pickup
  // leaves shipping_address NULL and the Prodigi order could never be built.
  if (hasPrints && (method !== 'kurier' || !address)) {
    return NextResponse.json({ error: 'invalid_delivery' }, { status: 400 });
  }
  // Prodigi ships prints to the EU + UK; InPost kurier (ceramics) is domestic.
  if (address) {
    const countryOk = hasPrints
      ? isPrintCountry(address.country_code)
      : address.country_code === 'PL';
    if (!countryOk) return NextResponse.json({ error: 'invalid_delivery' }, { status: 400 });
  }

  const unitPrices = valid.items.map((i) => i.unit_price);
  const subtotalMinor = unitPrices.reduce((s, v) => s + v, 0);
  let amount: number;
  if (hasPrints && address) {
    // Print carts charge Prodigi's shipping cost (see print-shipping.ts), not
    // the InPost price list.
    const hasFramed = valid.items.some((i) => i.variant?.framed);
    const framedCount = valid.items.filter((i) => i.variant?.framed).length;
    const shipMajor = printShippingOf(address.country_code as PrintCountry, hasFramed, chargeCurrency);
    const shipMinor =
      chargeCurrency === 'eur' ? toEuroCents(shipMajor) :
      chargeCurrency === 'gbp' ? toGBPPence(shipMajor) :
      toGrosze(shipMajor);
    if (framedCount > 1) {
      // ponytail: flat print shipping under-charges multi-frame orders — this
      // log is the observability signal only; revisit with Prodigi POST /quotes
      // when margin data shows the gap hurts (settled decision #5).
      console.warn(JSON.stringify({
        event: 'print_multi_frame_flat_shipping',
        framed_count: framedCount,
        item_count: valid.items.length,
        charge_currency: chargeCurrency,
        shipping_minor: shipMinor,
        has_framed: hasFramed,
        country: address.country_code,
      }));
    }
    amount = subtotalMinor + shipMinor;
  } else {
    amount =
      chargeCurrency === 'eur' ? orderAmountEuroCents(unitPrices, method) :
      chargeCurrency === 'gbp' ? orderAmountGBPPence(unitPrices, method) :
      orderAmountGrosze(unitPrices, method);
  }

  const supabase = getSupabaseAdmin();
  // A stable client-supplied attemptId lets a retried/duplicated POST (network
  // retry, second tab) re-enter its own reservation and PaymentIntent instead
  // of 409-ing itself (F4). It's unguessable (122 random bits from
  // crypto.randomUUID()), so the format check below is the only validation
  // needed before trusting it as the order id.
  const rawAttemptId = typeof body.attemptId === 'string' ? body.attemptId : null;
  const orderId = rawAttemptId && UUID_RE.test(rawAttemptId) ? rawAttemptId : crypto.randomUUID();

  // A private-sale token unlocks buying specific already-`sold` pieces via a secret
  // link, without relisting them in the shop. It uses a dedicated atomic RPC that
  // requires the cart to exactly match the link's bundle; normal carts reserve as usual.
  const privateSaleToken = normalizeToken(body.private_sale_token);
  let privateSaleId: string | null = null;

  // Private-sale links re-offer already-sold ceramic pieces; prints are
  // open-edition and never part of one (settled decision — see
  // docs/plans/ceramics-prints-separation/00-master.md #4). Reject before any
  // reservation is attempted.
  if (privateSaleToken && hasPrints) {
    return NextResponse.json({ error: 'private_sale_prints_unsupported' }, { status: 400 });
  }

  // Frees the pieces THIS request's reserve call holds. releaseReservedPieces
  // is status-scoped (only rows still `reserved` for this order id), so rows a
  // paid order already flipped to `sold` are never touched; private-sale holds
  // return to `sold`, normal holds to `available`. Release failures are logged,
  // not thrown — the response the caller is about to send must still go out.
  const releaseOwnHold = () =>
    releaseReservedPieces(supabase, { id: orderId, private_sale_id: privateSaleId })
      .catch((err) => console.error('checkout: failed to release hold for order', orderId, err));

  // Reads this attempt's order status. `lookupFailed` means the state is
  // UNKNOWN — a live checkout may own this attempt's hold, so the caller must
  // answer 409 checkout_in_progress (client keeps the attemptId and retries)
  // and must NOT release the hold or cancel any PaymentIntent on a guess.
  const readAttemptStatus = async (context: string) => {
    const { data, error } = await supabase
      .from('orders')
      .select('status')
      .eq('id', orderId)
      .maybeSingle();
    if (error) console.error(`checkout: order status lookup failed ${context}`, orderId, error);
    return {
      status: (data as { status: string } | null)?.status ?? null,
      lookupFailed: Boolean(error),
    };
  };

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
    paymentIntent = await stripe.paymentIntents.create(
      {
        amount,
        currency: chargeCurrency,
        payment_method_configuration: STRIPE_PMC_ID,
        metadata: {
          order_id: orderId,
          product_ids: ids.join(','),
          delivery_method: method,
          fulfilment_type: fulfilmentType,
          ...(privateSaleId ? { private_sale_id: privateSaleId } : {}),
          ...(hasPrints ? { has_prints: '1' } : {}),
        },
      },
      // Same key + same params → Stripe returns the SAME PaymentIntent instead
      // of creating a new one, so a retried POST replays onto the original PI.
      { idempotencyKey: `pi_create_${orderId}` },
    );
  } catch (err) {
    const stripeCode =
      (err as { code?: string } | null)?.code ??
      (err as { raw?: { code?: string } } | null)?.raw?.code;
    if (stripeCode === 'idempotency_key_in_use') {
      // A concurrent POST with this same attemptId is mid-flight: it owns the
      // shared hold and is about to hand its buyer a payable client_secret.
      // Releasing here would relist those pieces under a live payment — a
      // double-sell window. Report in-progress (409) so the client KEEPS its
      // attemptId; a retry click then replays onto the winner's order/PI
      // instead of starting a fresh attempt that 409s against its own hold.
      return NextResponse.json({ error: 'checkout_in_progress' }, { status: 409 });
    }
    const stripeErrType =
      (err as { type?: string } | null)?.type ??
      (err as { raw?: { type?: string } } | null)?.raw?.type;
    if (stripeErrType === 'idempotency_error') {
      // Stripe's idempotency keys expire after ~24h, so a retried attemptId can
      // collide as "same key, different params" instead of the in-progress
      // case above. Whether releasing is safe depends on whether THIS attempt
      // still owns a live checkout: check for a pending orders row before
      // deciding.
      const { status, lookupFailed } = await readAttemptStatus('after idempotency_error');
      if (lookupFailed) {
        return NextResponse.json({ error: 'checkout_in_progress' }, { status: 409 });
      }
      if (status === 'pending') {
        // A live checkout for this attemptId already owns the hold (and
        // possibly a client_secret in flight) — releasing would double-sell.
        // Ask the client to reset its attemptId instead.
        return NextResponse.json({ error: 'order_conflict' }, { status: 409 });
      }
      // No live order for this attemptId — a prior attempt died before the
      // orders insert. Safe to release exactly like the generic case below.
      await releaseOwnHold();
      return NextResponse.json({ error: 'stripe_failed' }, { status: 502 });
    }
    // Release the hold if Stripe failed, so pieces don't get stuck reserved.
    await releaseOwnHold();
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

  const { error: orderErr } = await supabase.from('orders').insert({
    id: orderId,
    payment_intent_id: paymentIntent.id,
    status: 'pending',
    currency: chargeCurrency,
    subtotal: subtotalMinor,
    shipping: amount - subtotalMinor,
    total: amount,
    shipping_method: method, // legacy NOT NULL column ÔÇö kept in sync with delivery_method
    delivery_method: method,
    // Explicit fulfilment discriminator (Finding 8): which pipeline owns this
    // order. Per-item truth stays order_items.variant.
    fulfilment_type: fulfilmentType,
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
  // A retried POST with the same attemptId hits this insert a second time and
  // gets a primary-key conflict on the row the first POST already created.
  // That's a replay, not a genuine failure — it must not fall into the
  // rollback below (which would cancel the still-live PI and release the
  // pieces the buyer is mid-payment on).
  let replay = false;
  if (orderErr?.code === PG_UNIQUE_VIOLATION) {
    // Can't tell a live replay from a stale attemptId without the status. The
    // PI above is the SAME live PI if this is a replay (idempotent create), so
    // on a failed lookup canceling or releasing could kill a payment mid-flight.
    const { status, lookupFailed } = await readAttemptStatus('on duplicate insert');
    if (lookupFailed) {
      return NextResponse.json({ error: 'checkout_in_progress' }, { status: 409 });
    }
    if (status === 'pending') {
      replay = true;
    } else {
      // The attemptId was already consumed by a different outcome (paid,
      // expired, ...) — not a valid replay of a live checkout. But THIS
      // request's reserve call above re-took a 15-min hold under that stale
      // order id; left in place it would 409 the buyer's next (fresh-attemptId)
      // click against their own orphaned hold. Free it — status-scoped, so a
      // paid order's `sold` pieces are untouched.
      await releaseOwnHold();
      // The PI create above (same idempotency key, expired after ~24h) minted
      // a FRESH PaymentIntent that has no orders row and never will — the
      // abandoned-checkout cron only reaps rows it can find. Best-effort
      // cancel it here so it doesn't strand an unreaped PI. Canceling an
      // already-succeeded PI (replayed after real payment) fails harmlessly
      // into the log below.
      try {
        await stripe.paymentIntents.cancel(paymentIntent.id);
      } catch (cancelErr) {
        console.error(
          'checkout: failed to cancel orphaned PaymentIntent (order_conflict)',
          paymentIntent.id,
          cancelErr,
        );
      }
      return NextResponse.json({ error: 'order_conflict' }, { status: 409 });
    }
  }
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
  if ((orderErr && !replay) || itemsErr) {
    // Persisting the order failed — undo so we never collect money without a record.
    try {
      await stripe.paymentIntents.cancel(paymentIntent.id);
    } catch (cancelErr) {
      // The PI is now orphaned (live, uncanceled) — surface it so it can be
      // canceled manually instead of silently expiring.
      console.error('checkout: failed to cancel orphaned PaymentIntent', paymentIntent.id, cancelErr);
    }
    if (itemsErr) {
      // The orders row was inserted but its items weren't. Left as 'pending'
      // it would poison a retry of the same attemptId: the replay branch above
      // would read it as a live checkout and hand back this now-canceled PI's
      // client_secret. Mark it failed so a retry lands in order_conflict.
      await supabase.from('orders').update({ status: 'failed' }).eq('id', orderId);
    }
    await releaseOwnHold();
    return NextResponse.json({ error: 'order_persist_failed' }, { status: 500 });
  }

  // Kick off the abandoned-checkout recovery flow (Resend Automation triggered by
  // cart.checkout_started). Best-effort and non-blocking: waitUntil lets it finish
  // after the response so it adds no latency to the pay request, and any Resend
  // failure is logged — never fails checkout. Skipped on a replayed POST — the
  // original POST already fired it for this order.
  if (!replay) {
    try {
      const { ctx } = getCloudflareContext();
      ctx.waitUntil(
        sendCheckoutStartedEvent({
          orderId,
          email: contact.email,
          locale,
          currency: chargeCurrency,
          totalMinor: amount,
          firstName: contact.first_name,
          origin,
        }).catch((err) => console.error('sendCheckoutStartedEvent failed for', orderId, err)),
      );
    } catch (err) {
      console.error('sendCheckoutStartedEvent dispatch failed for', orderId, err);
    }
  }

  return NextResponse.json({ client_secret: paymentIntent.client_secret });
}
