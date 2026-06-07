/**
 * Transactional email for shipping labels (Resend REST API — fetch-based,
 * Workers-friendly). Branded HTML lives in published Resend templates; this
 * module supplies localised variables and PDF attachments.
 *
 * NOTE: the `from` domains must be verified in Resend (ciok.art).
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';
import {
  RESEND_TEMPLATE_ALIASES,
  emailButton,
  emailDetailTable,
  emailMutedParagraph,
  emailParagraph,
} from './email-layout';
import { EMAIL, EMAIL_FROM } from './email-addresses';

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
}): Promise<void> {
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
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
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

// ── Customer shipping-confirmation email ─────────────────────────────────────

export type CustomerShippingOrder = {
  id: string;
  email: string | null;
  delivery_method: string;
  receiver_first_name: string | null;
  inpost_tracking_number: string | null;
  inpost_target_point: string | null;
};

type SupportedLocale = 'pl' | 'en' | 'es';

function resolveLocale(locale: string): SupportedLocale {
  if (locale === 'pl' || locale === 'en' || locale === 'es') return locale;
  return 'pl';
}

const I18N: Record<SupportedLocale, {
  subject: string;
  greeting: (name: string | null) => string;
  body1: string;
  trackingLabel: string;
  trackLink: string;
  paczkomatLabel: string;
  signOff: string;
}> = {
  pl: {
    subject: 'Twoje zamówienie zostało wysłane',
    greeting: (name) => (name ? `Cześć ${name}` : 'Cześć'),
    body1: 'Twoje zamówienie zostało nadane i jest w drodze.',
    trackingLabel: 'Numer przesyłki',
    trackLink: 'Śledź przesyłkę',
    paczkomatLabel: 'Paczkomat',
    signOff: 'Dziękujemy! Anna Ciok Studio',
  },
  en: {
    subject: 'Your order has been shipped',
    greeting: (name) => (name ? `Hi ${name}` : 'Hi'),
    body1: 'Your order has been shipped and is on its way.',
    trackingLabel: 'Tracking number',
    trackLink: 'Track your parcel',
    paczkomatLabel: 'Parcel locker',
    signOff: 'Thank you! Anna Ciok Studio',
  },
  es: {
    subject: 'Tu pedido ha sido enviado',
    greeting: (name) => (name ? `Hola ${name}` : 'Hola'),
    body1: 'Tu pedido ha sido enviado y está en camino.',
    trackingLabel: 'Número de seguimiento',
    trackLink: 'Sigue tu envío',
    paczkomatLabel: 'Punto de recogida',
    signOff: '¡Gracias! Anna Ciok Studio',
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
  const trackingUrl = tracking
    ? `https://inpost.pl/sledzenie-przesylek?number=${encodeURIComponent(tracking)}`
    : null;

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

  parts.push(emailMutedParagraph(t.signOff));

  const mainContent = parts.join('');
  return {
    subject: t.subject,
    html: mainContent,
    mainContent,
  };
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
