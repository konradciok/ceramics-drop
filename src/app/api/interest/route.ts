/**
 * Anonymous showroom-interest capture. A visitor viewing a showroom piece can
 * register interest in a similar future piece (email + optional message +
 * marketing consent). Submissions persist in `product_interest`, dedupe per
 * (product_id, email), and notify the studio by email.
 *
 * The route always answers `200 { ok: true }` on success regardless of whether
 * the row was new or a duplicate — client copy never has to explain "you
 * already asked about this", and submission history is never leaked.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { registryProductById } from '@/lib/products';
import { getShowroomIds } from '@/lib/inventory';
import { emailShowroomInterestToStudio } from '@/lib/email';
import { getClientIp } from '@/lib/client-ip';
import { createCheckoutRateLimiter } from '@/lib/checkout-rate-limit';
import { routing } from '@/i18n/routing';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE = 2000;

// Lightweight per-IP throttle for this public, email-triggering endpoint —
// reuses the checkout limiter (in-memory, per-isolate best-effort). Tighter than
// checkout: interest capture is low-frequency, so 10/min per IP is plenty.
const interestRateLimiter = createCheckoutRateLimiter({ maxRequests: 10, windowMs: 60 * 1000 });
// x-forwarded-for is spoofable off-Cloudflare, so only trust it outside production.
const TRUST_FORWARDED_IP = process.env.NODE_ENV !== 'production';

export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req, { trustForwarded: TRUST_FORWARDED_IP })?.trim() || null;
  const rateKey = clientIp ?? (TRUST_FORWARDED_IP ? null : 'unknown');
  const rate = interestRateLimiter.allow(rateKey);
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  let body: {
    product_id?: unknown;
    email?: unknown;
    message?: unknown;
    consent_marketing?: unknown;
    locale?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const productId = typeof body.product_id === 'string' ? body.product_id.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE) : '';
  const consentMarketing = body.consent_marketing === true;
  const locale = (routing.locales as readonly string[]).includes(String(body.locale)) ? String(body.locale) : 'pl';

  if (!productId || !registryProductById(productId)) {
    return NextResponse.json({ error: 'unknown_product' }, { status: 400 });
  }
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  }

  // The interest form only exists for showroom pieces — reject anything else so
  // this endpoint can't be used as a generic lead capture for live inventory.
  const showroom = await getShowroomIds().catch(() => [] as string[]);
  if (!showroom.includes(productId)) {
    return NextResponse.json({ error: 'not_showroom' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  // ignoreDuplicates → ON CONFLICT DO NOTHING; the returned rows are the ones
  // actually inserted (empty on a duplicate), so we can email the studio only
  // for genuinely new submissions and never spam the inbox on repeat clicks.
  const { data, error } = await supabase
    .from('product_interest')
    .upsert(
      {
        product_id: productId,
        email,
        message: message || null,
        consent_marketing: consentMarketing,
        locale,
      },
      { onConflict: 'product_id,email', ignoreDuplicates: true },
    )
    .select('id');
  if (error) {
    return NextResponse.json({ error: 'persist_failed' }, { status: 500 });
  }

  const isNew = (data?.length ?? 0) > 0;
  if (isNew) {
    // Studio notification is best-effort — a Resend outage must never fail the
    // customer-facing response (same posture as ensureInvoiced in the webhook).
    try {
      await emailShowroomInterestToStudio({
        interest: { productId, email, message: message || null, consentMarketing, locale },
      });
    } catch (err) {
      console.error('showroom interest email failed', { productId, err });
    }
  }

  // Always 200 regardless of new/duplicate — never leak submission history.
  return NextResponse.json({ ok: true });
}
