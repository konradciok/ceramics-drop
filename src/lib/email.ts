/**
 * Transactional email for shipping labels (Resend REST API — fetch-based,
 * Workers-friendly). The studio receives the printable A6 label PDF once a
 * shipment is confirmed.
 *
 * NOTE: the `from` domain must be verified in Resend (anna-ciok.studio).
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';

const FROM = 'Etykiety InPost <etykiety@anna-ciok.studio>';

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

export type LabelEmailOrder = {
  id: string;
  delivery_method: string;
  inpost_tracking_number: string | null;
  inpost_target_point: string | null;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
};

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

  const receiver = [order.receiver_first_name, order.receiver_last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  const methodLabel = order.delivery_method === 'paczkomat' ? 'Paczkomat' : 'Kurier';
  // Escape every interpolated value — order/receiver fields are user-supplied.
  const lines = [
    `Zamówienie: ${escapeHtml(order.id)}`,
    `Odbiorca: ${escapeHtml(receiver || '—')}`,
    `Sposób dostawy: ${methodLabel}`,
    order.inpost_target_point ? `Paczkomat: ${escapeHtml(order.inpost_target_point)}` : null,
    order.inpost_tracking_number
      ? `Numer przesyłki: ${escapeHtml(order.inpost_tracking_number)}`
      : null,
  ].filter(Boolean);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: [env.STUDIO_NOTIFY_EMAIL],
      subject: `Etykieta InPost — zamówienie ${order.id}`,
      html: `<p>Nowa etykieta InPost do wydruku.</p><pre>${lines.join('\n')}</pre>`,
      attachments: [
        {
          filename: `etykieta-${order.id}.pdf`,
          content: toBase64(labelPdf),
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
}

// ── Customer shipping-confirmation email ─────────────────────────────────────

/**
 * NOTE: the `from` domain (anna-ciok.studio) must be verified in Resend.
 */
const CUSTOMER_FROM = 'Anna Ciok Studio <sklep@anna-ciok.studio>';

export type CustomerShippingOrder = {
  id: string;
  email: string | null;
  delivery_method: string;               // 'paczkomat' | 'kurier' | 'odbior'
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
    greeting: (name) => name ? `Cześć ${name}` : 'Cześć',
    body1: 'Twoje zamówienie zostało nadane i jest w drodze.',
    trackingLabel: 'Numer przesyłki',
    trackLink: 'Śledź przesyłkę',
    paczkomatLabel: 'Paczkomat',
    signOff: 'Dziękujemy! Anna Ciok Studio',
  },
  en: {
    subject: 'Your order has been shipped',
    greeting: (name) => name ? `Hi ${name}` : 'Hi',
    body1: 'Your order has been shipped and is on its way.',
    trackingLabel: 'Tracking number',
    trackLink: 'Track your parcel',
    paczkomatLabel: 'Parcel locker',
    signOff: 'Thank you! Anna Ciok Studio',
  },
  es: {
    subject: 'Tu pedido ha sido enviado',
    greeting: (name) => name ? `Hola ${name}` : 'Hola',
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
}): { subject: string; html: string } {
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
    `<p>${greeting},</p>`,
    `<p>${t.body1}</p>`,
  ];

  if (tracking && trackingUrl) {
    parts.push(
      `<p>${t.trackingLabel}: ${escapeHtml(tracking)}<br>` +
      `<a href="${trackingUrl}">${t.trackLink}</a></p>`,
    );
  }

  if (order.delivery_method === 'paczkomat' && order.inpost_target_point) {
    parts.push(`<p>${t.paczkomatLabel}: ${escapeHtml(order.inpost_target_point)}</p>`);
  }

  parts.push(`<p>${t.signOff}</p>`);

  return {
    subject: t.subject,
    html: parts.join('\n'),
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
}> = {
  pl: {
    subject: 'Etykieta zwrotna — zamówienie',
    intro: 'Twoja prośba o zwrot została przyjęta. W załączniku znajdziesz etykietę zwrotną.',
    instructions: 'Wydrukuj etykietę lub pokaż kod QR w paczkomacie InPost, aby nadać przesyłkę.',
    signOff: 'Dziękujemy! Anna Ciok Studio',
  },
  en: {
    subject: 'Return label — order',
    intro: 'Your return request has been accepted. Please find the return label attached.',
    instructions: 'Print the label or show the QR code at an InPost parcel locker to send your return.',
    signOff: 'Thank you! Anna Ciok Studio',
  },
  es: {
    subject: 'Etiqueta de devolución — pedido',
    intro: 'Tu solicitud de devolución ha sido aceptada. Encontrarás la etiqueta de devolución adjunta.',
    instructions: 'Imprime la etiqueta o muéstrala en un punto de recogida InPost para enviar tu devolución.',
    signOff: '¡Gracias! Anna Ciok Studio',
  },
};

/** Pure function: builds localised subject + HTML for the return-label email. */
export function buildReturnLabelEmail(params: {
  order: ReturnLabelOrder;
  locale: string;
}): { subject: string; html: string } {
  const loc = resolveLocale(params.locale);
  const t = I18N_RETURN[loc];
  const firstName = params.order.receiver_first_name
    ? escapeHtml(params.order.receiver_first_name)
    : null;
  const greeting = firstName ? `${firstName},` : '';
  return {
    subject: `${t.subject} ${params.order.id}`,
    html: [
      greeting ? `<p>${greeting}</p>` : '',
      `<p>${t.intro}</p>`,
      `<p>${t.instructions}</p>`,
      `<p>${t.signOff}</p>`,
    ].filter(Boolean).join('\n'),
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

  const { subject, html } = buildReturnLabelEmail({ order, locale: params.locale });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: CUSTOMER_FROM,
      to: [order.email],
      subject,
      html,
      attachments: [
        {
          filename: `zwrot-${order.id}.pdf`,
          content: toBase64(labelPdf),
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
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

  const { subject, html } = buildShippingConfirmation(params);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: CUSTOMER_FROM,
      to: [order.email],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
}
