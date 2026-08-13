/**
 * Transactional email for shipping labels (Resend REST API — fetch-based,
 * Workers-friendly). Branded HTML lives in published Resend templates; this
 * module supplies localised variables and PDF attachments.
 *
 * NOTE: the `from` domains must be verified in Resend (ciok.art).
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { variantLabel } from './print-cart';
import type { PrintVariantSelection } from './types';
import {
  RESEND_TEMPLATE_ALIASES,
  emailButton,
  emailDetailTable,
  emailMutedParagraph,
  emailParagraph,
  resendTemplateHtml,
} from './email-layout';
import { EMAIL, EMAIL_FROM } from './email-addresses';
import { SITE_URL } from '@/lib/site';
import { inpostTrackingUrl } from '@/lib/tracking';

/** Escape user-supplied values before interpolating into the email HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** ArrayBuffer → base64 (Workers has btoa but no Buffer); chunked to avoid arg limits. */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

type ResendSendBody = Record<string, unknown>;

/** Send via a published Resend template (variables pre-escaped by callers). */
async function sendResendTemplate(params: {
  apiKey: string;
  from: string;
  to: string[];
  subject: string;
  templateId: string;
  variables: Record<string, string>;
  attachments?: Array<{ filename: string; content: string }>;
  signal?: AbortSignal;
}): Promise<{ id: string | null }> {
  const body: ResendSendBody = {
    from: params.from,
    to: params.to,
    reply_to: EMAIL.contact,
    subject: params.subject,
    template: {
      id: params.templateId,
      variables: params.variables,
    },
  };
  if (params.attachments?.length) {
    body.attachments = params.attachments;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  return { id: json?.id ?? null };
}

/** Send a one-off inline-HTML email (no published template needed). */
async function sendResendHtml(params: {
  apiKey: string;
  from: string;
  to: string[];
  subject: string;
  html: string;
}): Promise<{ id: string | null }> {
  const body: ResendSendBody = {
    from: params.from,
    to: params.to,
    reply_to: EMAIL.contact,
    subject: params.subject,
    html: params.html,
  };
  // Bound the request so a hung Resend connection can't stall the webhook.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${params.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
    }
    const json = (await res.json().catch(() => null)) as { id?: string } | null;
    return { id: json?.id ?? null };
  } finally {
    clearTimeout(timer);
  }
}

// ── Studio label email ───────────────────────────────────────────────────────

export type LabelEmailOrder = {
  id: string;
  delivery_method: string;
  inpost_tracking_number: string | null;
  inpost_target_point: string | null;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
};

/** Pure function — builds subject + inner HTML for the studio label email. */
export function buildLabelToStudioEmail(params: { order: LabelEmailOrder }): {
  subject: string;
  html: string;
  mainContent: string;
} {
  const { order } = params;
  const receiver = [order.receiver_first_name, order.receiver_last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  const methodLabel = order.delivery_method === 'paczkomat' ? 'Paczkomat' : 'Kurier';

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Zamówienie', value: escapeHtml(order.id) },
    { label: 'Odbiorca', value: escapeHtml(receiver || '—') },
    { label: 'Dostawa', value: methodLabel },
  ];
  if (order.inpost_target_point) {
    rows.push({ label: 'Paczkomat', value: escapeHtml(order.inpost_target_point) });
  }
  if (order.inpost_tracking_number) {
    rows.push({ label: 'Numer przesyłki', value: escapeHtml(order.inpost_tracking_number) });
  }

  const mainContent = [
    emailParagraph('<strong>Nowa etykieta InPost do wydruku.</strong>'),
    emailMutedParagraph('Etykieta A6 jest w załączniku PDF.'),
    emailDetailTable(rows),
  ].join('');

  return {
    subject: `[Etykieta] Etykieta InPost — zamówienie ${order.id}`,
    html: mainContent,
    mainContent,
  };
}

/** Email the A6 label PDF (+ tracking summary) to the studio for printing. */
export async function emailLabelToStudio(params: {
  order: LabelEmailOrder;
  labelPdf: ArrayBuffer;
}): Promise<void> {
  const { env } = getCloudflareContext();
  const { order, labelPdf } = params;

  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    throw new Error('Resend not configured: RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing');
  }

  const { subject, mainContent } = buildLabelToStudioEmail({ order });

  await sendResendTemplate({
    apiKey: env.RESEND_API_KEY,
    from: EMAIL_FROM,
    to: [env.STUDIO_NOTIFY_EMAIL],
    subject,
    templateId: RESEND_TEMPLATE_ALIASES.labelStudio,
    variables: { MAIN_CONTENT: mainContent },
    attachments: [
      {
        filename: `etykieta-${order.id}.pdf`,
        content: toBase64(labelPdf),
      },
    ],
  });
}

// ── Studio new-order notification ────────────────────────────────────────────

export type NewOrderEmailOrder = {
  id: string;
  email: string | null;
  total: number;          // grosze
  currency: string;
  delivery_method: string;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  inpost_target_point: string | null;
  items: Array<{
    product_id: string;
    unit_price: number;
    variant?: (PrintVariantSelection & { prodigiSku: string }) | null;
  }>;
};

function formatGrosze(grosze: number, currency: string): string {
  return `${(grosze / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

/** Pure function — subject + inner HTML for the studio "new paid order" email. */
export function buildNewOrderToStudioEmail(params: { order: NewOrderEmailOrder }): {
  subject: string;
  html: string;
  mainContent: string;
} {
  const { order } = params;
  const receiver = [order.receiver_first_name, order.receiver_last_name].filter(Boolean).join(' ').trim();
  const customer = [receiver, order.email].filter(Boolean).join(' · ') || '—';
  const methodLabel =
    order.delivery_method === 'paczkomat' ? 'Paczkomat'
    : order.delivery_method === 'kurier' ? 'Kurier'
    : 'Odbiór osobisty';

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Zamówienie', value: escapeHtml(order.id) },
    { label: 'Klient', value: escapeHtml(customer) },
    { label: 'Dostawa', value: methodLabel },
  ];
  if (order.inpost_target_point) {
    rows.push({ label: 'Paczkomat', value: escapeHtml(order.inpost_target_point) });
  }
  rows.push({ label: 'Pozycje', value: String(order.items.length) });
  rows.push({ label: 'Razem', value: formatGrosze(order.total, order.currency) });

  const itemLines = order.items
    .map((it) => {
      // Prints add a variant label + SKU so the studio knows exactly what to produce.
      const label = it.variant
        ? `${escapeHtml(it.product_id)} · ${escapeHtml(variantLabel(it.variant, 'pl'))} (${escapeHtml(it.variant.prodigiSku)})`
        : escapeHtml(it.product_id);
      return `${label} — ${formatGrosze(it.unit_price, order.currency)}`;
    })
    .join('<br />');

  const mainContent = [
    emailParagraph('<strong>Nowe opłacone zamówienie.</strong>'),
    emailDetailTable(rows),
    itemLines ? emailMutedParagraph(itemLines) : '',
  ].join('');

  return {
    subject: `[Zamówienie] Nowe opłacone zamówienie ${order.id}`,
    html: mainContent,
    mainContent,
  };
}

/** Email the studio about a new paid order. Throws if Resend isn't configured (caller must catch). */
export async function emailNewOrderToStudio(params: { order: NewOrderEmailOrder }): Promise<void> {
  const { env } = getCloudflareContext();
  const { order } = params;
  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    throw new Error('Resend not configured: RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing');
  }
  const { subject, mainContent } = buildNewOrderToStudioEmail({ order });
  const html = resendTemplateHtml().replace('{{{MAIN_CONTENT}}}', mainContent);
  await sendResendHtml({ apiKey: env.RESEND_API_KEY, from: EMAIL_FROM, to: [env.STUDIO_NOTIFY_EMAIL], subject, html });
}

// ── Studio showroom-interest notification ────────────────────────────────────

export type ShowroomInterest = {
  productId: string;
  email: string;
  message?: string | null;
  consentMarketing: boolean;
  locale: string;
};

/** Pure function — subject + inner HTML for the "new showroom interest" studio email. */
export function buildShowroomInterestEmail(params: { interest: ShowroomInterest }): {
  subject: string;
  html: string;
  mainContent: string;
} {
  const { interest } = params;
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Praca', value: escapeHtml(interest.productId) },
    { label: 'E-mail', value: escapeHtml(interest.email) },
    { label: 'Język', value: escapeHtml(interest.locale) },
    { label: 'Zgoda marketingowa', value: interest.consentMarketing ? 'Tak' : 'Nie' },
  ];

  const mainContent = [
    emailParagraph('<strong>Nowe zainteresowanie pracą ze showroomu.</strong>'),
    emailDetailTable(rows),
    interest.message ? emailMutedParagraph(escapeHtml(interest.message)) : '',
  ].join('');

  return {
    subject: `[Showroom] Nowe zainteresowanie — ${interest.productId}`,
    html: mainContent,
    mainContent,
  };
}

/** Notify the studio of a new showroom-interest submission. Throws if Resend isn't configured (caller must catch). */
export async function emailShowroomInterestToStudio(params: { interest: ShowroomInterest }): Promise<void> {
  const { env } = getCloudflareContext();
  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    throw new Error('Resend not configured: RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing');
  }
  const { subject, mainContent } = buildShowroomInterestEmail(params);
  const html = resendTemplateHtml().replace('{{{MAIN_CONTENT}}}', mainContent);
  await sendResendHtml({ apiKey: env.RESEND_API_KEY, from: EMAIL_FROM, to: [env.STUDIO_NOTIFY_EMAIL], subject, html });
}

// ── Studio print-refund alert ────────────────────────────────────────────────

export type PrintRefundAlert = {
  orderId: string;
  prodigiOrderId: string;
  stage: string;
};

/** Pure function — subject + inner HTML for the "print refunded, cancel manually" studio alert. */
export function buildPrintRefundAlertEmail(params: PrintRefundAlert): {
  subject: string;
  html: string;
  mainContent: string;
} {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Zamówienie', value: escapeHtml(params.orderId) },
    { label: 'Zamówienie Prodigi', value: escapeHtml(params.prodigiOrderId) },
    { label: 'Status Prodigi', value: escapeHtml(params.stage) },
  ];

  const mainContent = [
    emailParagraph('<strong>Zwrot za druk — zamówienia Prodigi nie udało się anulować automatycznie.</strong>'),
    emailParagraph(
      'Klient otrzymał zwrot pieniędzy, ale zamówienie w Prodigi jest już w produkcji lub wysłane. ' +
        'Anuluj je ręcznie w panelu Prodigi albo zaakceptuj koszt.',
    ),
    emailDetailTable(rows),
  ].join('');

  return {
    subject: `[Zwrot] Druk zwrócony — anuluj w Prodigi — zamówienie ${params.orderId}`,
    html: mainContent,
    mainContent,
  };
}

/** Alert the studio that a refunded print order needs manual handling in Prodigi. Throws if Resend isn't configured (caller must catch). */
export async function emailPrintRefundAlertToStudio(params: PrintRefundAlert): Promise<void> {
  const { env } = getCloudflareContext();
  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    throw new Error('Resend not configured: RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing');
  }
  const { subject, mainContent } = buildPrintRefundAlertEmail(params);
  const html = resendTemplateHtml().replace('{{{MAIN_CONTENT}}}', mainContent);
  await sendResendHtml({ apiKey: env.RESEND_API_KEY, from: EMAIL_FROM, to: [env.STUDIO_NOTIFY_EMAIL], subject, html });
}

// ── Studio refund-failed alert ───────────────────────────────────────────────

export type RefundFailedAlert = {
  /** Correlated order id, or null when the payment_intent matched no order. No other customer data belongs here. */
  orderId: string | null;
  refundId: string;
  failureReason: string | null;
};

/** Pure function — subject + inner HTML for the "refund never reached the customer" studio alert (Stripe `refund.failed`). */
export function buildRefundFailedAlertEmail(params: RefundFailedAlert): {
  subject: string;
  html: string;
  mainContent: string;
} {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Zamówienie', value: escapeHtml(params.orderId ?? '(nie znaleziono)') },
    { label: 'Zwrot Stripe', value: escapeHtml(params.refundId) },
    { label: 'Powód', value: escapeHtml(params.failureReason ?? '(brak)') },
  ];

  const mainContent = [
    emailParagraph('<strong>Zwrot pieniędzy nie dotarł do klienta.</strong>'),
    emailParagraph(
      'Stripe zgłosił refund.failed — bank odrzucił zwrot (np. zamknięte konto lub wygasła karta), ' +
        'a środki wróciły na saldo Stripe. Zamówienie w bazie pozostaje oznaczone jako zwrócone. ' +
        'Skontaktuj się z klientem i wykonaj zwrot inną metodą (np. przelewem).',
    ),
    emailDetailTable(rows),
  ].join('');

  return {
    subject: `[Zwrot] Zwrot nie dotarł do klienta — ${params.orderId ?? params.refundId}`,
    html: mainContent,
    mainContent,
  };
}

/** Alert the studio that an issued refund failed to reach the customer. Throws if Resend isn't configured (caller must catch). */
export async function emailRefundFailedAlertToStudio(params: RefundFailedAlert): Promise<void> {
  const { env } = getCloudflareContext();
  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    throw new Error('Resend not configured: RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing');
  }
  const { subject, mainContent } = buildRefundFailedAlertEmail(params);
  const html = resendTemplateHtml().replace('{{{MAIN_CONTENT}}}', mainContent);
  await sendResendHtml({ apiKey: env.RESEND_API_KEY, from: EMAIL_FROM, to: [env.STUDIO_NOTIFY_EMAIL], subject, html });
}

// ── Studio invoice-failed alert ──────────────────────────────────────────────

export type InvoiceFailedAlert = {
  paymentIntentId: string;
  errorMessage: string;
};

/** Pure function — subject + inner HTML for the "invoice creation failed" studio alert (L-5). */
export function buildInvoiceFailedAlertEmail(params: InvoiceFailedAlert): {
  subject: string;
  html: string;
  mainContent: string;
} {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'PaymentIntent', value: escapeHtml(params.paymentIntentId) },
    { label: 'Błąd', value: escapeHtml(params.errorMessage.slice(0, 300)) },
  ];

  const mainContent = [
    emailParagraph('<strong>Nie udało się wystawić faktury za opłacone zamówienie.</strong>'),
    emailParagraph(
      'Zamówienie i wysyłka są zrealizowane normalnie — fakturowanie jest best-effort i nie jest ponawiane automatycznie. ' +
        'Wystaw fakturę ręcznie w panelu Stripe albo ponów webhook dla tej płatności.',
    ),
    emailDetailTable(rows),
  ].join('');

  return {
    subject: `[Faktura] Nie udało się wystawić faktury — ${params.paymentIntentId}`,
    html: mainContent,
    mainContent,
  };
}

/** Alert the studio that invoicing failed for a paid order. Throws if Resend isn't configured (caller must catch — the route must still 200). */
export async function emailInvoiceFailedAlertToStudio(params: InvoiceFailedAlert): Promise<void> {
  const { env } = getCloudflareContext();
  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    throw new Error('Resend not configured: RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing');
  }
  const { subject, mainContent } = buildInvoiceFailedAlertEmail(params);
  const html = resendTemplateHtml().replace('{{{MAIN_CONTENT}}}', mainContent);
  await sendResendHtml({ apiKey: env.RESEND_API_KEY, from: EMAIL_FROM, to: [env.STUDIO_NOTIFY_EMAIL], subject, html });
}

// ── Studio dispute-created alert ─────────────────────────────────────────────

export type DisputeCreatedAlert = {
  /** Correlated order id, or null when the payment_intent matched no order. */
  orderId: string | null;
  disputeId: string;
  /** Amount in minor units, with its currency, straight off the Stripe dispute. */
  amount: number;
  currency: string;
  reason: string | null;
  /** `evidence_details.due_by` — unix seconds; missing it means an automatic loss. */
  evidenceDueBy: number | null;
};

/** Pure function — subject + inner HTML for the "dispute opened, response deadline running" studio alert (Stripe `charge.dispute.created`, L-6). */
export function buildDisputeCreatedAlertEmail(params: DisputeCreatedAlert): {
  subject: string;
  html: string;
  mainContent: string;
} {
  const dueBy = params.evidenceDueBy !== null
    ? new Date(params.evidenceDueBy * 1000).toISOString().slice(0, 10)
    : '(brak)';
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Zamówienie', value: escapeHtml(params.orderId ?? '(nie znaleziono)') },
    { label: 'Spór Stripe', value: escapeHtml(params.disputeId) },
    { label: 'Kwota', value: escapeHtml(`${(params.amount / 100).toFixed(2)} ${params.currency.toUpperCase()}`) },
    { label: 'Powód', value: escapeHtml(params.reason ?? '(brak)') },
    { label: 'Termin odpowiedzi', value: escapeHtml(dueBy) },
  ];

  const mainContent = [
    emailParagraph('<strong>Klient otworzył spór (chargeback).</strong>'),
    emailParagraph(
      'Stripe zamroził środki i czeka na odpowiedź z dowodami. ' +
        'Brak odpowiedzi przed terminem oznacza automatyczną przegraną — ' +
        'odpowiedz w panelu Stripe (Płatności → Spory) jak najszybciej.',
    ),
    emailDetailTable(rows),
  ].join('');

  return {
    subject: `[Spór] Nowy spór Stripe — odpowiedz do ${dueBy} — ${params.orderId ?? params.disputeId}`,
    html: mainContent,
    mainContent,
  };
}

/** Alert the studio that a dispute was opened (deadline-bearing). Throws if Resend isn't configured (caller must catch or let the webhook retry). */
export async function emailDisputeCreatedAlertToStudio(params: DisputeCreatedAlert): Promise<void> {
  const { env } = getCloudflareContext();
  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    throw new Error('Resend not configured: RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing');
  }
  const { subject, mainContent } = buildDisputeCreatedAlertEmail(params);
  const html = resendTemplateHtml().replace('{{{MAIN_CONTENT}}}', mainContent);
  await sendResendHtml({ apiKey: env.RESEND_API_KEY, from: EMAIL_FROM, to: [env.STUDIO_NOTIFY_EMAIL], subject, html });
}

// ── Studio private-sale double-payment alert ─────────────────────────────────

export type PrivateSaleDoublePaidAlert = {
  orderId: string;
  paymentIntentId: string;
};

/** Pure function — subject + inner HTML for the "private sale paid twice, second payment auto-refunded" studio alert (M-5). */
export function buildPrivateSaleDoublePaidAlertEmail(params: PrivateSaleDoublePaidAlert): {
  subject: string;
  html: string;
  mainContent: string;
} {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Zamówienie', value: escapeHtml(params.orderId) },
    { label: 'PaymentIntent', value: escapeHtml(params.paymentIntentId) },
  ];

  const mainContent = [
    emailParagraph('<strong>Podwójna płatność za sprzedaż prywatną.</strong>'),
    emailParagraph(
      'Dwa zamówienia z tego samego linku sprzedaży prywatnej zostały opłacone. ' +
        'Druga płatność została automatycznie zwrócona, a jej zamówienie oznaczone jako nieudane. ' +
        'Zweryfikuj zwrot w panelu Stripe i skontaktuj się z kupującym.',
    ),
    emailDetailTable(rows),
  ].join('');

  return {
    subject: `[Zwrot] Podwójna płatność — sprzedaż prywatna — zamówienie ${params.orderId}`,
    html: mainContent,
    mainContent,
  };
}

/** Alert the studio that a private sale was paid twice and the second payment was auto-refunded. Throws if Resend isn't configured (caller must catch). */
export async function emailPrivateSaleDoublePaidAlertToStudio(params: PrivateSaleDoublePaidAlert): Promise<void> {
  const { env } = getCloudflareContext();
  if (!env.RESEND_API_KEY || !env.STUDIO_NOTIFY_EMAIL) {
    throw new Error('Resend not configured: RESEND_API_KEY / STUDIO_NOTIFY_EMAIL missing');
  }
  const { subject, mainContent } = buildPrivateSaleDoublePaidAlertEmail(params);
  const html = resendTemplateHtml().replace('{{{MAIN_CONTENT}}}', mainContent);
  await sendResendHtml({ apiKey: env.RESEND_API_KEY, from: EMAIL_FROM, to: [env.STUDIO_NOTIFY_EMAIL], subject, html });
}

// ── Customer shipping-confirmation email ─────────────────────────────────────

export type CustomerShippingOrder = {
  id: string;
  email: string | null;
  delivery_method: string;
  receiver_first_name: string | null;
  inpost_tracking_number: string | null;
  inpost_target_point: string | null;
};

type SupportedLocale = 'pl' | 'en' | 'es' | 'de';

function resolveLocale(locale: string): SupportedLocale {
  if (locale === 'pl' || locale === 'en' || locale === 'es' || locale === 'de') return locale;
  if (locale === 'gb') return 'en'; // legacy pre-merge orders emailed in English
  return 'pl';
}

const I18N: Record<SupportedLocale, {
  subject: string;
  greeting: (name: string | null) => string;
  body1: string;
  trackingLabel: string;
  trackLink: string;
  paczkomatLabel: string;
  returnsLabel: string;
  returnsLink: string;
  signOff: string;
}> = {
  pl: {
    subject: 'Twoje zamówienie zostało wysłane',
    greeting: (name) => (name ? `Cześć ${name}` : 'Cześć'),
    body1: 'Twoje zamówienie zostało nadane i jest w drodze.',
    trackingLabel: 'Numer przesyłki',
    trackLink: 'Śledź przesyłkę',
    paczkomatLabel: 'Paczkomat',
    returnsLabel: 'Chcesz zwrócić zakup? Masz na to 14 dni od otrzymania paczki.',
    returnsLink: 'Rozpocznij zwrot',
    signOff: 'Dziękujemy! Anna Ciok Studio',
  },
  en: {
    subject: 'Your order has been shipped',
    greeting: (name) => (name ? `Hi ${name}` : 'Hi'),
    body1: 'Your order has been shipped and is on its way.',
    trackingLabel: 'Tracking number',
    trackLink: 'Track your parcel',
    paczkomatLabel: 'Parcel locker',
    returnsLabel: 'Want to return your order? You have 14 days from delivery.',
    returnsLink: 'Start a return',
    signOff: 'Thank you! Anna Ciok Studio',
  },
  es: {
    subject: 'Tu pedido ha sido enviado',
    greeting: (name) => (name ? `Hola ${name}` : 'Hola'),
    body1: 'Tu pedido ha sido enviado y está en camino.',
    trackingLabel: 'Número de seguimiento',
    trackLink: 'Sigue tu envío',
    paczkomatLabel: 'Punto de recogida',
    returnsLabel: '¿Quieres devolver tu pedido? Tienes 14 días desde la entrega.',
    returnsLink: 'Iniciar devolución',
    signOff: '¡Gracias! Anna Ciok Studio',
  },
  de: {
    subject: 'Deine Bestellung wurde versandt',
    greeting: (name) => (name ? `Hallo ${name}` : 'Hallo'),
    body1: 'Deine Bestellung wurde versandt und ist auf dem Weg.',
    trackingLabel: 'Sendungsnummer',
    trackLink: 'Sendung verfolgen',
    paczkomatLabel: 'Paketfach',
    returnsLabel: 'Möchtest du deine Bestellung zurückgeben? Du hast 14 Tage ab Lieferung.',
    returnsLink: 'Rücksendung starten',
    signOff: 'Danke! Anna Ciok Studio',
  },
};

/**
 * Pure function — no I/O. Builds a localised subject + HTML body for the
 * customer shipping-confirmation email. Unit-testable without any env setup.
 */
export function buildShippingConfirmation(params: {
  order: CustomerShippingOrder;
  locale: string;
}): { subject: string; html: string; mainContent: string } {
  const { order } = params;
  const loc = resolveLocale(params.locale);
  const t = I18N[loc];

  const firstName = order.receiver_first_name ? escapeHtml(order.receiver_first_name) : null;
  const greeting = t.greeting(firstName);

  const tracking = order.inpost_tracking_number;
  const trackingUrl = tracking ? inpostTrackingUrl(tracking) : null;

  const parts: string[] = [
    emailParagraph(`${greeting},`),
    emailParagraph(t.body1),
  ];

  if (tracking && trackingUrl) {
    parts.push(
      emailParagraph(
        `${t.trackingLabel}: <strong>${escapeHtml(tracking)}</strong>`,
      ),
      emailButton(trackingUrl, t.trackLink),
    );
  }

  if (order.delivery_method === 'paczkomat' && order.inpost_target_point) {
    parts.push(
      emailParagraph(
        `${t.paczkomatLabel}: <strong>${escapeHtml(order.inpost_target_point)}</strong>`,
      ),
    );
  }

  const returnUrl = `${SITE_URL}/${loc === 'pl' ? '' : loc + '/'}zwrot?order=${encodeURIComponent(order.id)}`;
  parts.push(emailParagraph(t.returnsLabel), emailButton(returnUrl, t.returnsLink));

  parts.push(emailMutedParagraph(t.signOff));

  const mainContent = parts.join('');
  return {
    subject: t.subject,
    html: mainContent,
    mainContent,
  };
}

// ── Print shipping-confirmation (Prodigi) ────────────────────────────────────

export type PrintShippingOrder = {
  id: string;
  email: string | null;
  receiver_first_name: string | null;
};

export type PrintTracking = {
  number: string | null;
  url: string | null;
  carrier?: string | null;
};

/**
 * Pure function — localised "your print has shipped" email. Prints go by
 * courier (Prodigi) to EU/UK addresses: carrier tracking instead of the InPost
 * link, no locker language, and no returns block (prints are not returnable —
 * see createOrderReturn).
 */
export function buildPrintShippingConfirmation(params: {
  order: PrintShippingOrder;
  tracking: PrintTracking;
  locale: string;
}): { subject: string; html: string; mainContent: string } {
  const { order, tracking } = params;
  const loc = resolveLocale(params.locale);
  const t = I18N[loc];

  const firstName = order.receiver_first_name ? escapeHtml(order.receiver_first_name) : null;

  const parts: string[] = [
    emailParagraph(`${t.greeting(firstName)},`),
    emailParagraph(t.body1),
  ];

  if (tracking.number) {
    const carrier = tracking.carrier ? ` (${escapeHtml(tracking.carrier)})` : '';
    parts.push(
      emailParagraph(`${t.trackingLabel}: <strong>${escapeHtml(tracking.number)}</strong>${carrier}`),
    );
    if (tracking.url) parts.push(emailButton(tracking.url, t.trackLink));
  }

  parts.push(emailMutedParagraph(t.signOff));

  const mainContent = parts.join('');
  return { subject: t.subject, html: mainContent, mainContent };
}

/**
 * Send the print shipping-confirmation via Resend. Throws when config or the
 * recipient email is missing (the Prodigi callback treats the send as
 * best-effort and releases its claim on failure).
 *
 * `env` is injectable because this is also reached from the M-12 cron
 * reconciliation sweep, which runs OUTSIDE the request AsyncLocalStorage —
 * `getCloudflareContext()` throws there (same C-2 class of bug as the queue
 * consumer). Request-path callers may omit it.
 */
export async function emailPrintShippingConfirmationToCustomer(params: {
  order: PrintShippingOrder;
  tracking: PrintTracking;
  locale: string;
  env?: CloudflareEnv;
}): Promise<void> {
  const env = params.env ?? getCloudflareContext().env;
  const { order } = params;

  if (!env.RESEND_API_KEY) {
    throw new Error('Resend not configured: RESEND_API_KEY missing');
  }
  if (!order.email) {
    throw new Error(`Cannot send print shipping confirmation: order ${order.id} has no email`);
  }

  const { subject, mainContent } = buildPrintShippingConfirmation(params);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await sendResendTemplate({
      apiKey: env.RESEND_API_KEY,
      from: EMAIL_FROM,
      to: [order.email],
      subject,
      templateId: RESEND_TEMPLATE_ALIASES.shippingConfirmation,
      variables: { MAIN_CONTENT: mainContent },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Return label email ───────────────────────────────────────────────────────

export type ReturnLabelOrder = {
  id: string;
  email: string | null;
  receiver_first_name: string | null;
};

const I18N_RETURN: Record<SupportedLocale, {
  subject: string;
  intro: string;
  instructions: string;
  signOff: string;
  filename: string;
}> = {
  pl: {
    subject: 'Etykieta zwrotna — zamówienie',
    intro: 'Twoja prośba o zwrot została przyjęta. W załączniku znajdziesz etykietę zwrotną.',
    instructions:
      'Wydrukuj etykietę lub pokaż kod QR w paczkomacie InPost, aby nadać przesyłkę.',
    signOff: 'Dziękujemy! Anna Ciok Studio',
    filename: 'zwrot',
  },
  en: {
    subject: 'Return label — order',
    intro: 'Your return request has been accepted. Please find the return label attached.',
    instructions:
      'Print the label or show the QR code at an InPost parcel locker to send your return.',
    signOff: 'Thank you! Anna Ciok Studio',
    filename: 'return',
  },
  es: {
    subject: 'Etiqueta de devolución — pedido',
    intro: 'Tu solicitud de devolución ha sido aceptada. Encontrarás la etiqueta de devolución adjunta.',
    instructions:
      'Imprime la etiqueta o muéstrala en un punto de recogida InPost para enviar tu devolución.',
    signOff: '¡Gracias! Anna Ciok Studio',
    filename: 'devolucion',
  },
  de: {
    subject: 'Rücksendeetikett — Bestellung',
    intro: 'Deine Rücksendeanfrage wurde akzeptiert. Das Rücksendeetikett findest du im Anhang.',
    instructions:
      'Drucke das Etikett aus oder zeige den QR-Code an einem InPost-Paketfach, um dein Paket aufzugeben.',
    signOff: 'Danke! Anna Ciok Studio',
    filename: 'ruecksendung',
  },
};

/** Pure function: builds localised subject + HTML for the return-label email. */
export function buildReturnLabelEmail(params: {
  order: ReturnLabelOrder;
  locale: string;
}): { subject: string; html: string; mainContent: string } {
  const loc = resolveLocale(params.locale);
  const t = I18N_RETURN[loc];
  const firstName = params.order.receiver_first_name
    ? escapeHtml(params.order.receiver_first_name)
    : null;

  const parts: string[] = [];
  if (firstName) {
    parts.push(emailParagraph(`${firstName},`));
  }
  parts.push(
    emailParagraph(t.intro),
    emailParagraph(t.instructions),
    emailMutedParagraph(t.signOff),
  );

  const mainContent = parts.join('');
  return {
    subject: `${t.subject} ${params.order.id}`,
    html: mainContent,
    mainContent,
  };
}

/** Send the customer a return-label PDF via Resend. */
export async function emailReturnLabelToCustomer(params: {
  order: ReturnLabelOrder;
  labelPdf: ArrayBuffer;
  locale: string;
}): Promise<void> {
  const { env } = getCloudflareContext();
  const { order, labelPdf } = params;

  if (!env.RESEND_API_KEY) {
    throw new Error('Resend not configured: RESEND_API_KEY missing');
  }
  if (!order.email) {
    throw new Error(`Cannot send return label: order ${order.id} has no email`);
  }

  const loc = resolveLocale(params.locale);
  const { subject, mainContent } = buildReturnLabelEmail({ order, locale: params.locale });

  await sendResendTemplate({
    apiKey: env.RESEND_API_KEY,
    from: EMAIL_FROM,
    to: [order.email],
    subject,
    templateId: RESEND_TEMPLATE_ALIASES.returnLabel,
    variables: { MAIN_CONTENT: mainContent },
    attachments: [
      {
        filename: `${I18N_RETURN[loc].filename}-${order.id}.pdf`,
        content: toBase64(labelPdf),
      },
    ],
  });
}

// ── Customer order-confirmation email ────────────────────────────────────────

export type OrderConfirmationOrder = {
  id: string;
  email: string | null;
  receiver_first_name: string | null;
};

// Intentionally duplicates deliveryNotice.* from messages/*.json — the Workers
// runtime cannot read filesystem files, so email builders carry their own i18n.
// Keep in sync manually when July copy changes.
const I18N_ORDER_CONFIRMATION: Record<SupportedLocale, {
  subject: string;
  greeting: (name: string | null) => string;
  thankYou: string;
  deliveryTitle: string;
  deliveryP1: string;
  deliveryP2: string;
  deliveryP3: string;
  signOff: string;
}> = {
  pl: {
    subject: 'Zamówienie przyjęte — Anna Ciok Ceramics',
    greeting: (name) => (name ? `Cześć ${name}` : 'Cześć'),
    thankYou: 'Dziękuję za zamówienie! Potwierdzam jego przyjęcie i wkrótce zajmę się pakowaniem.',
    deliveryTitle: 'Informacja o dostawie w lipcu',
    deliveryP1: 'Wszystkie zamówienia na terenie Polski będą wysyłane za pośrednictwem InPost — kurierem lub do Paczkomatów.',
    deliveryP2: 'Przyjeżdżamy do Polski 5 lipca. Wszystkie zamówienia złożone wcześniej zostaną wysłane od 10 lipca. Zamówienia składane później będą wysyłane w ciągu 1–3 dni od momentu złożenia zamówienia.',
    deliveryP3: 'Wysyłki będą realizowane od 10 lipca.',
    signOff: 'Do zobaczenia! Anna Ciok Studio',
  },
  en: {
    subject: 'Order confirmed — Anna Ciok Ceramics',
    greeting: (name) => (name ? `Hi ${name}` : 'Hi'),
    thankYou: 'Thank you for your order! I\'ve confirmed it and will start packing soon.',
    deliveryTitle: 'July delivery information',
    deliveryP1: 'All orders in Poland will be shipped via InPost courier or InPost parcel lockers.',
    deliveryP2: 'We arrive in Poland on 5 July. All orders placed earlier will be shipped from 10 July. Orders placed later will be shipped within 1–3 days after the order is placed.',
    deliveryP3: 'Shipping will take place in July, from 10 July.',
    signOff: 'Talk soon! Anna Ciok Studio',
  },
  es: {
    subject: 'Pedido confirmado — Anna Ciok Ceramics',
    greeting: (name) => (name ? `Hola ${name}` : 'Hola'),
    thankYou: '¡Gracias por tu pedido! Lo he confirmado y pronto empezaré a embalarlo.',
    deliveryTitle: 'Información sobre entregas en julio',
    deliveryP1: 'Todos los pedidos dentro de Polonia se enviarán a través de InPost, por mensajería o a taquillas Paczkomaty.',
    deliveryP2: 'Llegamos a Polonia el 5 de julio. Todos los pedidos realizados anteriormente se enviarán a partir del 10 de julio. Los pedidos realizados posteriormente se enviarán en un plazo de 1 a 3 días después de realizar el pedido.',
    deliveryP3: 'Los envíos se realizarán en julio, a partir del 10 de julio.',
    signOff: '¡Hasta pronto! Anna Ciok Studio',
  },
  de: {
    subject: 'Bestellung bestätigt — Anna Ciok Ceramics',
    greeting: (name) => (name ? `Hallo ${name}` : 'Hallo'),
    thankYou: 'Danke für deine Bestellung! Ich habe sie bestätigt und werde bald mit dem Einpacken beginnen.',
    deliveryTitle: 'Lieferinformationen für Juli',
    deliveryP1: 'Alle Bestellungen in Polen werden über InPost — per Kurier oder an Paczkomat-Paketfächer — versandt.',
    deliveryP2: 'Wir kommen am 5. Juli nach Polen. Alle früher aufgegebenen Bestellungen werden ab dem 10. Juli versandt. Später aufgegebene Bestellungen werden innerhalb von 1–3 Tagen nach Bestelleingang versandt.',
    deliveryP3: 'Der Versand erfolgt im Juli, ab dem 10. Juli.',
    signOff: 'Bis bald! Anna Ciok Studio',
  },
};

// Print orders: Prodigi produces on demand and couriers across EU/UK — no
// InPost / Poland / locker language. Same manual-sync rule as the map above.
const I18N_ORDER_CONFIRMATION_PRINT: typeof I18N_ORDER_CONFIRMATION = {
  pl: {
    subject: 'Zamówienie przyjęte — Anna Ciok Ceramics',
    greeting: (name) => (name ? `Cześć ${name}` : 'Cześć'),
    thankYou: 'Dziękuję za zamówienie! Potwierdzam jego przyjęcie — Twoja grafika trafia właśnie do druku.',
    deliveryTitle: 'Informacja o realizacji',
    deliveryP1: 'Druki fine-art powstają na zamówienie u naszego partnera drukarskiego Prodigi.',
    deliveryP2: 'Produkcja trwa zwykle 2–5 dni roboczych. Po nadaniu przesyłki wyślemy e-mail z numerem do śledzenia.',
    deliveryP3: 'Dostawa kurierem na terenie Unii Europejskiej i Wielkiej Brytanii.',
    signOff: 'Do zobaczenia! Anna Ciok Studio',
  },
  en: {
    subject: 'Order confirmed — Anna Ciok Ceramics',
    greeting: (name) => (name ? `Hi ${name}` : 'Hi'),
    thankYou: 'Thank you for your order! It\'s confirmed — your print is on its way to production.',
    deliveryTitle: 'Fulfilment information',
    deliveryP1: 'Fine-art prints are produced on demand by our print partner Prodigi.',
    deliveryP2: 'Production usually takes 2–5 business days. Once your order ships, you\'ll receive an email with a tracking number.',
    deliveryP3: 'Courier delivery across the EU and the UK.',
    signOff: 'Talk soon! Anna Ciok Studio',
  },
  es: {
    subject: 'Pedido confirmado — Anna Ciok Ceramics',
    greeting: (name) => (name ? `Hola ${name}` : 'Hola'),
    thankYou: '¡Gracias por tu pedido! Está confirmado — tu lámina va camino de la producción.',
    deliveryTitle: 'Información sobre la producción',
    deliveryP1: 'Las láminas fine-art se producen bajo demanda con nuestro socio de impresión Prodigi.',
    deliveryP2: 'La producción suele tardar de 2 a 5 días laborables. Cuando tu pedido se envíe, recibirás un correo con el número de seguimiento.',
    deliveryP3: 'Entrega por mensajería en la Unión Europea y el Reino Unido.',
    signOff: '¡Hasta pronto! Anna Ciok Studio',
  },
  de: {
    subject: 'Bestellung bestätigt — Anna Ciok Ceramics',
    greeting: (name) => (name ? `Hallo ${name}` : 'Hallo'),
    thankYou: 'Danke für deine Bestellung! Sie ist bestätigt — dein Druck geht jetzt in die Produktion.',
    deliveryTitle: 'Informationen zur Herstellung',
    deliveryP1: 'Fine-Art-Drucke werden auf Bestellung bei unserem Druckpartner Prodigi gefertigt.',
    deliveryP2: 'Die Produktion dauert in der Regel 2–5 Werktage. Sobald deine Bestellung versandt wurde, erhältst du eine E-Mail mit der Sendungsnummer.',
    deliveryP3: 'Kurierlieferung innerhalb der EU und nach Großbritannien.',
    signOff: 'Bis bald! Anna Ciok Studio',
  },
};

/** Which fulfilment path the order follows — selects the confirmation copy. */
export type OrderEmailKind = 'ceramic' | 'print';

/** Pure function — builds localised subject + HTML for the customer order-confirmation email. */
export function buildOrderConfirmationEmail(params: {
  order: OrderConfirmationOrder;
  locale: string;
  /** Defaults to ceramic — existing callers keep their copy. */
  kind?: OrderEmailKind;
}): { subject: string; html: string; mainContent: string } {
  const { order } = params;
  const loc = resolveLocale(params.locale);
  const t = (params.kind === 'print' ? I18N_ORDER_CONFIRMATION_PRINT : I18N_ORDER_CONFIRMATION)[loc];

  const firstName = order.receiver_first_name ? escapeHtml(order.receiver_first_name) : null;
  const greeting = t.greeting(firstName);

  const mainContent = [
    emailParagraph(`${greeting},`),
    emailParagraph(t.thankYou),
    emailParagraph(`<strong>${escapeHtml(t.deliveryTitle)}</strong>`),
    emailParagraph(t.deliveryP1),
    emailParagraph(t.deliveryP2),
    emailMutedParagraph(t.deliveryP3),
    emailMutedParagraph(t.signOff),
  ].join('');

  return { subject: t.subject, html: mainContent, mainContent };
}

/** Send the customer a localised order-confirmation email via Resend. Throws if RESEND_API_KEY is missing (caller catches). */
export async function emailOrderConfirmationToCustomer(params: {
  order: OrderConfirmationOrder;
  locale: string;
  kind?: OrderEmailKind;
  /** Explicit env (e.g. from the orders CLI) — defaults to the current Workers env. */
  env?: CloudflareEnv;
}): Promise<{ id: string | null }> {
  const env = params.env ?? getCloudflareContext().env;
  const { order } = params;

  if (!env.RESEND_API_KEY) {
    throw new Error('Resend not configured: RESEND_API_KEY missing');
  }
  if (!order.email) return { id: null };

  const { subject, mainContent } = buildOrderConfirmationEmail(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await sendResendTemplate({
      apiKey: env.RESEND_API_KEY,
      from: EMAIL_FROM,
      to: [order.email],
      subject,
      templateId: RESEND_TEMPLATE_ALIASES.shippingConfirmation,
      variables: { MAIN_CONTENT: mainContent },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send the customer a localised shipping-confirmation email via Resend.
 * Throws if config is missing, email is falsy, or Resend returns a non-ok response
 * (so the InPost webhook handler can 500 and trigger a retry).
 */
export async function emailShippingConfirmationToCustomer(params: {
  order: CustomerShippingOrder;
  locale: string;
}): Promise<void> {
  const { env } = getCloudflareContext();
  const { order } = params;

  if (!env.RESEND_API_KEY) {
    throw new Error('Resend not configured: RESEND_API_KEY missing');
  }
  if (!order.email) {
    throw new Error(`Cannot send shipping confirmation: order ${order.id} has no email`);
  }

  const { subject, mainContent } = buildShippingConfirmation(params);

  await sendResendTemplate({
    apiKey: env.RESEND_API_KEY,
    from: EMAIL_FROM,
    to: [order.email],
    subject,
    templateId: RESEND_TEMPLATE_ALIASES.shippingConfirmation,
    variables: { MAIN_CONTENT: mainContent },
  });
}
