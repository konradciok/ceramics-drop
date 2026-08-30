import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { validateCart } from '@/lib/checkout';
import { currencyFromCookieHeader, toChargeableCurrency } from '@/lib/currency';
import {
  normalizePromoCode,
  fetchPromoByCode,
  checkPromoEligibility,
  computePromoDiscountMinor,
} from '@/lib/promo';
import { getClientIp } from '@/lib/client-ip';
import { createCheckoutRateLimiter } from '@/lib/checkout-rate-limit';

/**
 * Rate-limited promo-code preview for the cart page. Read-only: no DB writes,
 * no reservation, no redemption claim — `/api/checkout` re-validates
 * authoritatively. Ineligible codes answer 200 `{ ok: false, reason }` (data,
 * not an error — matching the /api/inventory read style); only malformed
 * requests 400.
 */

export const dynamic = 'force-dynamic';

// Own bucket, same budget as checkout — blocks promo-code enumeration.
const promoRateLimiter = createCheckoutRateLimiter();
const TRUST_FORWARDED_IP = process.env.NODE_ENV !== 'production';
const VALID_LOCALES = ['pl', 'en', 'es', 'de'] as const;

export async function POST(req: Request) {
  const clientIp = getClientIp(req, { trustForwarded: TRUST_FORWARDED_IP })?.trim() || null;
  const rateKey = clientIp ?? (TRUST_FORWARDED_IP ? null : 'unknown');
  const rate = promoRateLimiter.allow(rateKey);
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const code = normalizePromoCode(body.code);
  const ids = Array.isArray(body.ids) && body.ids.every((v) => typeof v === 'string')
    ? (body.ids as string[])
    : null;
  if (!code || !ids || ids.length === 0) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  // Currency exactly like checkout: `currency_pref` cookie, clamped to a
  // chargeable currency, with the locale driving the no-cookie default.
  const locale =
    typeof body.locale === 'string' && (VALID_LOCALES as readonly string[]).includes(body.locale)
      ? body.locale
      : 'pl';
  const currency = toChargeableCurrency(currencyFromCookieHeader(locale, req.headers.get('cookie')));

  const valid = await validateCart(ids, currency);
  if (!valid.ok) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const hasPrints = valid.items.some((i) => i.variant);
  const { promo, redemptionCount } = await fetchPromoByCode(getSupabaseAdmin(), code);
  const eligibility = checkPromoEligibility(promo, hasPrints ? 'prints' : 'ceramics', redemptionCount);
  if (!eligibility.ok) {
    return NextResponse.json({ ok: false, reason: eligibility.reason });
  }

  const subtotalMinor = valid.items.reduce((s, i) => s + i.unit_price, 0);
  // Shipping enters the discount math only through the Stripe-minimum clamp.
  // The preview doesn't know the delivery method/country yet, so it passes 0 —
  // the CONSERVATIVE input (a previewed discount can only be ≤ what checkout,
  // which knows real shipping, will grant). Checkout stays the authority.
  const discount = computePromoDiscountMinor(eligibility.promo, subtotalMinor, 0, currency);
  return NextResponse.json({ ok: true, code, discount });
}
