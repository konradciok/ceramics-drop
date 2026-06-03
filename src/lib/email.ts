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
