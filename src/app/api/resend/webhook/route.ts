import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { verifyResendSignature, parseResendEvent } from '@/lib/resend-webhook';

export const dynamic = 'force-dynamic';

// Event types we surface in logs. Everything else is acked but ignored.
const LOGGED_EVENT_TYPES = new Set([
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.delivery_delayed',
]);

/**
 * Inbound Resend (Svix-signed) webhook for transactional-mail delivery health.
 * Registered in the Resend dashboard for the `ciok.art` sending domain at
 * `…/api/resend/webhook`. We verify the signature, then log a structured line
 * for delivered/bounced/complained events so deliverability is observable in
 * Workers logs. We deliberately avoid logging recipient addresses (PII) — the
 * `email_id` correlates back to the Resend dashboard.
 */
export async function POST(req: Request) {
  const { env } = getCloudflareContext();

  // Fail closed: without the signing secret we cannot trust any event.
  if (!env.RESEND_WEBHOOK_SECRET) {
    console.error('resend webhook: RESEND_WEBHOOK_SECRET not configured');
    return NextResponse.json({ error: 'not_configured' }, { status: 500 });
  }

  // This handler only logs, so duplicate deliveries are harmless. If it ever
  // mutates state, dedupe on `svix-id` first — Svix retries the same id.
  const svixId = req.headers.get('svix-id');
  const svixTimestamp = req.headers.get('svix-timestamp');
  const svixSignature = req.headers.get('svix-signature');
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 });
  }

  // Signature is over the raw bytes — read text before any parsing.
  const payload = await req.text();

  const valid = await verifyResendSignature({
    secret: env.RESEND_WEBHOOK_SECRET,
    svixId,
    svixTimestamp,
    svixSignature,
    payload,
  });
  if (!valid) {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const evt = parseResendEvent(raw);
  if (!evt) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  if (LOGGED_EVENT_TYPES.has(evt.type)) {
    const bounce =
      evt.data.bounce && typeof evt.data.bounce === 'object'
        ? (evt.data.bounce as Record<string, unknown>)
        : null;
    console.log(
      JSON.stringify({
        event: 'resend_webhook',
        type: evt.type,
        email_id: evt.data.email_id ?? null,
        created_at: evt.created_at ?? null,
        ...(bounce ? { bounce_type: bounce.type ?? null } : {}),
      }),
    );
  }

  return NextResponse.json({ received: true });
}
