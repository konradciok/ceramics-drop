import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getSupabaseAdmin } from '@/lib/supabase';
import { carriersFromEnv } from '@/lib/carriers';
import { parseSendcloudWebhook, verifySendcloudSignature } from '@/lib/carriers/sendcloud/webhook';
import { applySendcloudParcelUpdate } from '@/server/sendcloud-parcel-update';

export const dynamic = 'force-dynamic';

/**
 * Inbound Sendcloud `parcel_status_changed` callback, registered in the
 * Sendcloud API integration ("Webhook feedback enabled") as
 * `https://anna-ciok.studio/api/sendcloud/webhook`.
 *
 * Signed with SENDCLOUD_WEBHOOK_SIGNATURE_KEY (`Sendcloud-Signature`, hex
 * HMAC-SHA256 of the raw body). Sendcloud wants a 2xx within 10 s and retries
 * 5xx/timeouts for ~1.5 h; any other 4xx stops its retries. After that the
 * 15-min cron sweep (src/server/sweep-sendcloud-shipments.ts) is the backstop.
 */
export async function POST(req: Request) {
  const { env } = getCloudflareContext();

  const rawBody = await req.text();
  const signed = await verifySendcloudSignature(
    rawBody,
    req.headers.get('sendcloud-signature'),
    env.SENDCLOUD_WEBHOOK_SIGNATURE_KEY,
  );
  if (!signed) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  // Other actions (integration_updated, …) and parcels that are not ours are
  // acknowledged, so Sendcloud does not retry them.
  const update = parseSendcloudWebhook(raw);
  if (!update) return NextResponse.json({ received: true, ignored: true });

  const supabase = getSupabaseAdmin();
  const carriers = carriersFromEnv(env, supabase);
  try {
    const outcome = await applySendcloudParcelUpdate(
      { supabase, getLabelPdf: (id) => carriers('sendcloud').getLabelPdf(id) },
      update,
    );
    return NextResponse.json({ received: true, outcome });
  } catch (err) {
    // A DB or email failure → 500 so Sendcloud redelivers (claims keep it once-only).
    console.error(
      JSON.stringify({ event: 'sendcloud_webhook_failed', order_id: update.orderId, status: update.status }),
      err,
    );
    return NextResponse.json({ error: 'update_failed' }, { status: 500 });
  }
}
