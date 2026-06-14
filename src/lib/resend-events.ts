/**
 * Resend Events emission (Workers-friendly, fetch-based). Fires custom events to
 * Resend Automations from the checkout API route and the Stripe webhook:
 *
 *   cart.checkout_started  → on a successful POST /api/checkout (order pending)
 *   cart.purchased         → on payment_intent.succeeded (markPaid)
 *
 * The "Abandoned checkout — 30m" automation triggers on cart.checkout_started,
 * waits 30 min for cart.purchased for the same contact, and — if it never
 * arrives — sends a localised recovery email (template alias `abandoned-checkout`,
 * MAIN_CONTENT filled from event.main_content_html).
 *
 * The automation's send_email step uses a STATIC per-locale subject (Resend does
 * not substitute variables into the subject), so the subjects below are the
 * version-controlled source of truth and MUST match the automation config — the
 * `subject drift guard` test pins them together.
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { emailButton, emailMutedParagraph, emailParagraph } from './email-layout';
import { SITE_URL } from '@/lib/site';

export const ABANDONED_CART_EVENTS = {
  checkoutStarted: 'cart.checkout_started',
  purchased: 'cart.purchased',
} as const;

type SupportedLocale = 'pl' | 'en' | 'es';

function resolveLocale(locale: string): SupportedLocale {
  if (locale === 'pl' || locale === 'en' || locale === 'es') return locale;
  if (locale === 'gb' || locale === 'de') return 'en'; // gb/de → English confirmation emails
  return 'pl';
}

/** Escape user-supplied values before interpolating into the email HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Static subjects — kept identical to the Resend automation's send_email steps. */
export const AUTOMATION_SUBJECTS: Record<SupportedLocale, string> = {
  pl: 'Twój koszyk czeka',
  en: 'Your cart is waiting',
  es: 'Tu cesta te espera',
};

const I18N_ABANDONED: Record<SupportedLocale, {
  greeting: (name: string | null) => string;
  body1: string;
  body2: string;
  cta: string;
  signOff: string;
}> = {
  pl: {
    greeting: (name) => (name ? `Cześć ${name}` : 'Cześć'),
    body1: 'Twoje wybrane ceramiki wciąż czekają w koszyku.',
    body2: 'Każda praca jest jedyna w swoim rodzaju — gdy zniknie, znika na dobre.',
    cta: 'Dokończ zamówienie',
    signOff: 'Do zobaczenia! Anna Ciok Studio',
  },
  en: {
    greeting: (name) => (name ? `Hi ${name}` : 'Hi'),
    body1: 'Your chosen pieces are still waiting in your cart.',
    body2: "Each piece is one of a kind — once it's gone, it's gone.",
    cta: 'Complete your order',
    signOff: 'See you soon! Anna Ciok Studio',
  },
  es: {
    greeting: (name) => (name ? `Hola ${name}` : 'Hola'),
    body1: 'Las piezas que elegiste siguen esperando en tu cesta.',
    body2: 'Cada pieza es única — cuando se va, se va para siempre.',
    cta: 'Completar tu pedido',
    signOff: '¡Hasta pronto! Anna Ciok Studio',
  },
};

const KNOWN_LOCALES = new Set(['pl', 'en', 'es', 'de', 'gb']);

/**
 * Build an absolute, locale-aware cart URL. Polish (default) is unprefixed;
 * all other known locales are prefixed. Unknown locales fall back to the
 * unprefixed (Polish) URL. `origin` (e.g. the checkout request origin) wins
 * when present, otherwise the canonical SITE_URL is used.
 */
export function cartUrlForLocale(locale: string, origin?: string): string {
  const base = origin && origin.length > 0 ? origin : SITE_URL;
  const knownLocale = KNOWN_LOCALES.has(locale) ? locale : 'pl';
  const prefix = knownLocale === 'pl' ? '' : `/${knownLocale}`;
  return `${base}${prefix}/koszyk`;
}

/**
 * Pure function — no I/O. Builds the localised subject + inner HTML
 * (MAIN_CONTENT) for the abandoned-checkout recovery email.
 */
export function buildAbandonedCartEmail(params: {
  locale: string;
  firstName: string | null;
  cartUrl: string;
}): { subject: string; mainContent: string } {
  const loc = resolveLocale(params.locale);
  const t = I18N_ABANDONED[loc];
  const firstName = params.firstName ? escapeHtml(params.firstName) : null;

  const mainContent = [
    emailParagraph(`${t.greeting(firstName)},`),
    emailParagraph(t.body1),
    emailParagraph(t.body2),
    emailButton(params.cartUrl, t.cta),
    emailMutedParagraph(t.signOff),
  ].join('');

  return { subject: AUTOMATION_SUBJECTS[loc], mainContent };
}

export type CheckoutStartedPayload = {
  order_id: string;
  locale: string;
  currency: string;
  total_minor: number;
  cart_url: string;
  first_name: string;
  subject: string;
  main_content_html: string;
};

/** Build the cart.checkout_started event payload (includes the rendered email). */
export function buildCheckoutStartedPayload(params: {
  orderId: string;
  locale: string;
  currency: string;
  totalMinor: number;
  firstName: string | null;
  cartUrl: string;
}): CheckoutStartedPayload {
  const { subject, mainContent } = buildAbandonedCartEmail({
    locale: params.locale,
    firstName: params.firstName,
    cartUrl: params.cartUrl,
  });
  return {
    order_id: params.orderId,
    locale: params.locale,
    currency: params.currency,
    total_minor: params.totalMinor,
    cart_url: params.cartUrl,
    first_name: params.firstName ?? '',
    subject,
    main_content_html: mainContent,
  };
}

/** Build the cart.purchased event payload (cancels the recovery for this contact). */
export function buildPurchasedPayload(orderId: string): { order_id: string } {
  return { order_id: orderId };
}

/**
 * POST a custom event to Resend to trigger/advance an Automation. The contact is
 * identified by email (Resend creates it on first use when the automation runs).
 * Throws on a non-ok response so callers can log + swallow.
 */
export async function sendResendEvent(params: {
  apiKey: string;
  event: string;
  email: string;
  payload: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const doFetch = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await doFetch('https://api.resend.com/events/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event: params.event,
        email: params.email,
        payload: params.payload,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire cart.checkout_started. Best-effort: callers invoke this fire-and-forget
 * (`void ...catch(log)`) so a Resend hiccup never blocks checkout. No-ops when
 * the order has no email. Throws if RESEND_API_KEY is unset (caller swallows).
 */
export async function sendCheckoutStartedEvent(params: {
  orderId: string;
  email: string | null;
  locale: string;
  currency: string;
  totalMinor: number;
  firstName: string | null;
  origin?: string;
}): Promise<void> {
  if (!params.email) return;
  const { env } = getCloudflareContext();
  if (!env.RESEND_API_KEY) {
    throw new Error('Resend not configured: RESEND_API_KEY missing');
  }
  const cartUrl = cartUrlForLocale(params.locale, params.origin);
  const payload = buildCheckoutStartedPayload({
    orderId: params.orderId,
    locale: params.locale,
    currency: params.currency,
    totalMinor: params.totalMinor,
    firstName: params.firstName,
    cartUrl,
  });
  await sendResendEvent({
    apiKey: env.RESEND_API_KEY,
    event: ABANDONED_CART_EVENTS.checkoutStarted,
    email: params.email,
    payload,
  });
}

/**
 * Fire cart.purchased — cancels the pending recovery for this contact. Must use
 * the SAME email as the checkout_started event so Resend matches the run.
 * Best-effort; no-ops when the order has no email.
 */
export async function sendPurchasedEvent(params: {
  orderId: string;
  email: string | null;
}): Promise<void> {
  if (!params.email) return;
  const { env } = getCloudflareContext();
  if (!env.RESEND_API_KEY) {
    throw new Error('Resend not configured: RESEND_API_KEY missing');
  }
  await sendResendEvent({
    apiKey: env.RESEND_API_KEY,
    event: ABANDONED_CART_EVENTS.purchased,
    email: params.email,
    payload: buildPurchasedPayload(params.orderId),
  });
}
