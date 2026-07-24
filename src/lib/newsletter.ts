/**
 * Newsletter double opt-in (stateless, Resend-backed).
 *
 * POST /api/newsletter mints an HMAC-signed confirm token and emails a
 * localised confirmation link; GET /api/newsletter/confirm verifies it and
 * only then creates the Resend contact. No subscriber state is stored on our
 * side before the click — the token itself carries {email, locale, iat} — so
 * the flow needs no database table and an unconfirmed signup leaves no record.
 *
 * Like resend-events.ts, this module is getCloudflareContext-free: builders
 * are pure and the senders take the API key (and an injectable fetch) as
 * parameters, so unit tests need no env mocking. The token secret is
 * NEWSLETTER_CONFIRM_SECRET — dedicated and fail-closed (routes 503 when it
 * is unset), never reused from other services (CMS_PREVIEW_SECRET posture).
 */
import { routing, type Locale } from '@/i18n/routing';
import { localePath } from '@/lib/locale-path';
import {
  emailButton,
  emailMutedParagraph,
  emailParagraph,
  resendTemplateHtml,
} from './email-layout';
import { EMAIL, EMAIL_FROM } from './email-addresses';

export const NEWSLETTER_CONFIRM_TTL_SECS = 60 * 60 * 24 * 7; // 7 days — generous for inbox lag
/** Tolerated future clock skew on a token's iat (isolate clocks can drift). */
const IAT_SKEW_SECS = 300;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type NewsletterConfirmStatus = 'confirmed' | 'expired' | 'invalid' | 'error';

type ConfirmPayload = { email: string; locale: Locale; iat: number };

export type VerifyConfirmResult =
  | { ok: true; email: string; locale: Locale }
  | { ok: false; reason: 'invalid' }
  // Expired tokens passed the signature check, so their locale is trustworthy
  // and the confirm route can land the visitor on a localised "link expired" page.
  | { ok: false; reason: 'expired'; locale: Locale };

const enc = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(b64);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function importHmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage],
  );
}

/** Mint `base64url(payload).base64url(hmac)` for the confirm link. */
export async function mintConfirmToken(params: {
  email: string;
  locale: Locale;
  secret: string;
  nowMs?: number;
}): Promise<string> {
  const iat = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const payload: ConfirmPayload = { email: params.email, locale: params.locale, iat };
  const body = base64Url(enc.encode(JSON.stringify(payload)));
  const key = await importHmacKey(params.secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${base64Url(new Uint8Array(sig))}`;
}

/**
 * Verify a confirm token. Signature first (constant-time via
 * crypto.subtle.verify), then payload sanity, then the time window — so
 * `expired` is only ever reported for a genuinely minted token, and every
 * forgery collapses into `invalid`.
 */
export async function verifyConfirmToken(
  token: string | null | undefined,
  secret: string,
  nowMs = Date.now(),
): Promise<VerifyConfirmResult> {
  const invalid = { ok: false, reason: 'invalid' } as const;
  if (!token) return invalid;
  const parts = token.split('.');
  if (parts.length !== 2) return invalid;
  const [body, signature] = parts;
  if (!body || !signature || !BASE64URL_RE.test(body) || !BASE64URL_RE.test(signature)) return invalid;

  const key = await importHmacKey(secret, 'verify');
  let ok: boolean;
  try {
    // fromBase64Url throws on charset-valid but length-invalid segments
    // (stripped length ≡ 1 mod 4 makes atob reject) — such a token is a
    // forgery and must collapse into `invalid`, never bubble up as a 500.
    ok = await crypto.subtle.verify('HMAC', key, arrayBuffer(fromBase64Url(signature)), enc.encode(body));
  } catch {
    return invalid;
  }
  if (!ok) return invalid;

  let payload: ConfirmPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as ConfirmPayload;
  } catch {
    return invalid;
  }
  if (typeof payload?.email !== 'string' || !EMAIL_RE.test(payload.email)) return invalid;
  if (!(routing.locales as readonly string[]).includes(payload.locale)) return invalid;
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return invalid;

  const now = Math.floor(nowMs / 1000);
  if (payload.iat > now + IAT_SKEW_SECS) return invalid;
  if (now - payload.iat > NEWSLETTER_CONFIRM_TTL_SECS) {
    return { ok: false, reason: 'expired', locale: payload.locale };
  }
  return { ok: true, email: payload.email, locale: payload.locale };
}

/** Absolute confirm-endpoint URL embedded in the email (origin from getWorkerOrigin). */
export function newsletterConfirmUrl(token: string, origin: string): string {
  return `${origin}/api/newsletter/confirm?token=${encodeURIComponent(token)}`;
}

function resolveLocale(locale: string): Locale {
  return (routing.locales as readonly string[]).includes(locale) ? (locale as Locale) : routing.defaultLocale;
}

/** Locale-aware landing path (pl unprefixed) the confirm route redirects to. */
export function newsletterLandingPath(locale: string, status: NewsletterConfirmStatus): string {
  return `${localePath(resolveLocale(locale), '/newsletter')}?status=${status}`;
}

/** Confirmation-email copy — carried in code like I18N_ABANDONED (emails render
 *  outside the next-intl request context, so messages/*.json can't serve them). */
const I18N_CONFIRM: Record<Locale, {
  subject: string;
  greeting: string;
  body: string;
  cta: string;
  expiry: string;
  ignore: string;
  signOff: string;
}> = {
  pl: {
    subject: 'Potwierdź zapis do newslettera — Anna Ciok Ceramics',
    greeting: 'Cześć,',
    body: 'Dziękujemy za chęć zapisu do newslettera Anna Ciok Ceramics. Kliknij przycisk poniżej, aby potwierdzić swój adres e-mail.',
    cta: 'Potwierdzam zapis',
    expiry: 'Link jest ważny przez 7 dni.',
    ignore: 'Jeśli to nie Ty prosiłeś(-aś) o zapis, po prostu zignoruj tę wiadomość — nie zostaniesz zapisany(-a).',
    signOff: 'Do zobaczenia! Anna Ciok Studio',
  },
  en: {
    subject: 'Confirm your newsletter signup — Anna Ciok Ceramics',
    greeting: 'Hi,',
    body: 'Thank you for signing up to the Anna Ciok Ceramics newsletter. Click the button below to confirm your email address.',
    cta: 'Confirm signup',
    expiry: 'This link is valid for 7 days.',
    ignore: "If you didn't request this, simply ignore this email — you won't be subscribed.",
    signOff: 'Talk soon! Anna Ciok Studio',
  },
  es: {
    subject: 'Confirma tu suscripción — Anna Ciok Ceramics',
    greeting: 'Hola,',
    body: 'Gracias por suscribirte al boletín de Anna Ciok Ceramics. Haz clic en el botón para confirmar tu correo electrónico.',
    cta: 'Confirmar suscripción',
    expiry: 'Este enlace es válido durante 7 días.',
    ignore: 'Si no has solicitado esto, ignora este correo — no quedarás suscrito.',
    signOff: '¡Hasta pronto! Anna Ciok Studio',
  },
  de: {
    subject: 'Bestätige deine Newsletter-Anmeldung — Anna Ciok Ceramics',
    greeting: 'Hallo,',
    body: 'Danke für deine Anmeldung zum Anna Ciok Ceramics Newsletter. Klicke auf den Button, um deine E-Mail-Adresse zu bestätigen.',
    cta: 'Anmeldung bestätigen',
    expiry: 'Dieser Link ist 7 Tage gültig.',
    ignore: 'Wenn du das nicht warst, ignoriere diese E-Mail einfach — du wirst nicht angemeldet.',
    signOff: 'Bis bald! Anna Ciok Studio',
  },
};

/**
 * Pure builder for the confirmation email. Nothing user-supplied enters the
 * HTML: the confirm URL is server-built (base64url alphabet + encodeURIComponent,
 * no HTML-special characters) and the address itself is never interpolated.
 */
export function buildNewsletterConfirmEmail(params: {
  locale: string;
  confirmUrl: string;
}): { subject: string; mainContent: string; html: string } {
  const t = I18N_CONFIRM[resolveLocale(params.locale)];
  const mainContent = [
    emailParagraph(t.greeting),
    emailParagraph(t.body),
    emailButton(params.confirmUrl, t.cta),
    emailMutedParagraph(t.expiry),
    emailMutedParagraph(t.ignore),
    emailMutedParagraph(t.signOff),
  ].join('');
  const html = resendTemplateHtml().replace('{{{MAIN_CONTENT}}}', mainContent);
  return { subject: t.subject, mainContent, html };
}

async function postResendJson(params: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const doFetch = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await doFetch(params.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Send the confirmation email (inline HTML — no published template needed). Throws on non-ok. */
export async function sendNewsletterConfirmEmail(params: {
  apiKey: string;
  to: string;
  subject: string;
  html: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const res = await postResendJson({
    url: 'https://api.resend.com/emails',
    apiKey: params.apiKey,
    body: {
      from: EMAIL_FROM,
      to: [params.to],
      reply_to: EMAIL.contact,
      subject: params.subject,
      html: params.html,
    },
    fetchImpl: params.fetchImpl,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
}

/**
 * Create the Resend contact once the link is clicked. Defaults to the global
 * /contacts endpoint (current Resend model); an audienceId switches to the
 * legacy /audiences/{id}/contacts endpoint for accounts still on Audiences.
 * An existing contact (409 or an "already exists" message, depending on the
 * account model) is success — re-clicking an old confirm link must stay
 * idempotent. Throws on any other failure.
 */
export async function subscribeNewsletterContact(params: {
  apiKey: string;
  email: string;
  audienceId?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const url = params.audienceId
    ? `https://api.resend.com/audiences/${encodeURIComponent(params.audienceId)}/contacts`
    : 'https://api.resend.com/contacts';
  const res = await postResendJson({
    url,
    apiKey: params.apiKey,
    body: { email: params.email, unsubscribed: false },
    fetchImpl: params.fetchImpl,
  });
  if (res.ok) return;
  const detail = await res.text().catch(() => '');
  if (res.status === 409 || /already exist/i.test(detail)) return;
  throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
}
