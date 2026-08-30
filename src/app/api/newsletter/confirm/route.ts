/**
 * Newsletter confirm — step 2 of the stateless double opt-in. Verifies the
 * HMAC token from the emailed link and only then creates the Resend contact.
 * Every token-level outcome 302-redirects to the localised /newsletter landing
 * page — a human clicked this from an email and must land on a page, not JSON.
 *
 * Known limitation (accepted): a GET with a side effect means link prefetchers
 * (e.g. Outlook SafeLinks) can confirm on the visitor's behalf. The standard
 * hardening — landing on a page whose explicit button POSTs the confirmation —
 * is a future option if scanner-confirms show up in practice.
 */
import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getClientIp } from '@/lib/client-ip';
import { createCheckoutRateLimiter } from '@/lib/checkout-rate-limit';
import { routing } from '@/i18n/routing';
import {
  buildNewsletterWelcomeEmail,
  newsletterLandingPath,
  sendNewsletterWelcomeEmail,
  subscribeNewsletterContact,
  verifyConfirmToken,
  type NewsletterConfirmStatus,
} from '@/lib/newsletter';
import { getActiveNewsletterPromo } from '@/lib/promo';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/** Hard cap well above any real token — bounds the work verify does on garbage. */
const MAX_TOKEN_LENGTH = 1024;

// Humans click once; 20/min absorbs mail-scanner rescans without mattering for
// brute force (the HMAC signature is unguessable regardless). Same per-isolate
// best-effort caveat as the other public routes.
const confirmRateLimiter = createCheckoutRateLimiter({ maxRequests: 20, windowMs: 60 * 1000 });
const TRUST_FORWARDED_IP = process.env.NODE_ENV !== 'production';

export async function GET(req: Request) {
  const clientIp = getClientIp(req, { trustForwarded: TRUST_FORWARDED_IP })?.trim() || null;
  const rateKey = clientIp ?? (TRUST_FORWARDED_IP ? null : 'unknown');
  const rate = confirmRateLimiter.allow(rateKey);
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const { env } = getCloudflareContext();
  if (!env.NEWSLETTER_CONFIRM_SECRET || !env.RESEND_API_KEY) {
    return NextResponse.json({ error: 'newsletter_unavailable' }, { status: 503 });
  }

  // Resolve against the origin the click actually arrived at (prod/staging/
  // preview all correct); no-store so a transient-failure redirect can't be
  // cached and replayed as the "result" of a later click. The redirect also
  // strips the token before any page renders, keeping it out of page_view URLs.
  const redirectTo = (locale: string, status: NewsletterConfirmStatus) =>
    NextResponse.redirect(new URL(newsletterLandingPath(locale, status), req.url), {
      status: 302,
      headers: { 'Cache-Control': 'no-store' },
    });

  const rawToken = new URL(req.url).searchParams.get('token');
  const token = rawToken && rawToken.length <= MAX_TOKEN_LENGTH ? rawToken : null;
  const verdict = await verifyConfirmToken(token, env.NEWSLETTER_CONFIRM_SECRET);
  if (!verdict.ok) {
    // 'expired' passed the signature check, so its locale is trustworthy;
    // 'invalid' carries no trustworthy payload → default-locale landing.
    return verdict.reason === 'expired'
      ? redirectTo(verdict.locale, 'expired')
      : redirectTo(routing.defaultLocale, 'invalid');
  }

  try {
    await subscribeNewsletterContact({
      apiKey: env.RESEND_API_KEY,
      email: verdict.email,
      audienceId: env.RESEND_NEWSLETTER_AUDIENCE_ID || undefined,
    });
  } catch (err) {
    console.error('newsletter subscribe failed', err);
    // The token is still valid — re-clicking the same link retries cleanly.
    return redirectTo(verdict.locale, 'error');
  }

  // "new silter" resolution (master plan Requirement #4): the original brief's
  // "new silter … inviting email" has zero repo prior art for invite/silter —
  // the newsletter double opt-in is the only invitation-like flow, so a new
  // subscriber gets the admin-flagged promo (at most one, newsletter_welcome
  // AND active) in a welcome email sent here, best-effort. Inert while no
  // promo carries the flag — confirm this reading with the operator before
  // enabling it in production (Phase 7 open item).
  try {
    const promo = await getActiveNewsletterPromo(getSupabaseAdmin());
    if (promo) {
      const { subject, html } = buildNewsletterWelcomeEmail({ locale: verdict.locale, promo });
      await sendNewsletterWelcomeEmail({ apiKey: env.RESEND_API_KEY, to: verdict.email, subject, html });
    }
  } catch (err) {
    // Best-effort: a failed lookup or send must never break the opt-in the
    // subscriber already completed above.
    console.error('newsletter welcome email failed', err);
  }

  return redirectTo(verdict.locale, 'confirmed');
}
