import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { adminSupabase, adminStripe } from '@/lib/admin/clients';
import { isUuid } from '@/lib/uuid';
import { refundBalanceOrder } from '@/server/balance-refunds';

export const dynamic = 'force-dynamic';

/** Cloudflare Access protects all /api/admin routes in worker.ts. Amount is
 * in order-currency minor units. Clients MUST retain refundId after a timeout. */
export async function POST(req: Request) {
  let body;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid_request' }, { status: 400 }); }
  if (!isUuid(body?.orderId) || !isUuid(body?.refundId) || !Number.isSafeInteger(body?.amount) || body.amount <= 0) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  try {
    const { env } = getCloudflareContext();
    const status = await refundBalanceOrder(body.orderId, body.refundId, body.amount, { supabase: adminSupabase(), stripe: adminStripe(), env });
    return NextResponse.json({ status }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'balance_refund_failed';
    const conflict = ['order_not_refundable','invalid_refund_amount','refund_attempt_conflict','refund_in_progress'].includes(message);
    return NextResponse.json({ error: conflict ? message : 'balance_refund_requires_retry' }, { status: conflict ? 409 : 502 });
  }
}
