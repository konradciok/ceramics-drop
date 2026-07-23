/**
 * Newsletter signup — step 1 of the stateless double opt-in. Validates the
 * address, mints an HMAC confirm token (NEWSLETTER_CONFIRM_SECRET) and emails
 * a localised confirmation link via Resend. The contact is created only when
 * the link is clicked (see ./confirm/route.ts) — nothing is persisted here, so
 * an already-subscribed address simply receives another confirm email and no
 * membership information can leak.
 */
import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getClientIp } from '@/lib/client-ip';
import { createCheckoutRateLimiter } from '@/lib/checkout-rate-limit';
import { getWorkerOrigin } from '@/lib/site.server';
import { routing, type Locale } from '@/i18n/routing';
import {
  buildNewsletterConfirmEmail,
  mintConfirmToken,
  newsletterConfirmUrl,
  sendNewsletterConfirmEmail,
} from '@/lib/newsletter';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Tighter than /api/interest (10/min): every accepted POST sends an outbound
// email, so the per-IP budget doubles as the mail throttle. In-memory ⇒
// per-isolate best-effort on Workers (same accepted caveat as checkout); the
// durable control is a Cloudflare WAF rate-limit rule.
const newsletterRateLimiter = createCheckoutRateLimiter({ maxRequests: 5, windowMs: 60 * 1000 });
// x-forwarded-for is spoofable off-Cloudflare, so only trust it outside production.
const TRUST_FORWARDED_IP = process.env.NODE_ENV !== 'production';

export async function POST(req: Request) {
  const clientIp = getClientIp(req, { trustForwarded: TRUST_FORWARDED_IP })?.trim() || null;
  const rateKey = clientIp ?? (TRUST_FORWARDED_IP ? null : 'unknown');
  const rate = newsletterRateLimiter.allow(rateKey);
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  // Fail closed before any per-request work: the token secret and the Resend
  // key are both required to complete the opt-in. NEWSLETTER_CONFIRM_SECRET is
  // dedicated — never reused from other services (CMS_PREVIEW_SECRET posture).
  const { env } = getCloudflareContext();
  if (!env.NEWSLETTER_CONFIRM_SECRET || !env.RESEND_API_KEY) {
    return NextResponse.json({ error: 'newsletter_unavailable' }, { status: 503 });
  }

  let body: { email?: unknown; locale?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  }
  const locale = ((routing.locales as readonly string[]).includes(String(body.locale))
    ? String(body.locale)
    : routing.defaultLocale) as Locale;

  try {
    const token = await mintConfirmToken({ email, locale, secret: env.NEWSLETTER_CONFIRM_SECRET });
    const confirmUrl = newsletterConfirmUrl(token, getWorkerOrigin(env));
    const { subject, html } = buildNewsletterConfirmEmail({ locale, confirmUrl });
    // Awaited (unlike the best-effort studio notifications): the UI tells the
    // visitor to check their inbox, so a silent send failure would strand them.
    await sendNewsletterConfirmEmail({ apiKey: env.RESEND_API_KEY, to: email, subject, html });
  } catch (err) {
    console.error('newsletter confirm email failed', err); // no token in the log line
    return NextResponse.json({ error: 'send_failed' }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
