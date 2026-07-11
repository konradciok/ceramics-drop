/* LOCAL-ONLY admin route: issue a Stripe refund for a paid order. Thin HTTP
 * adapter over `refundOrder()` in src/lib/admin/actions.ts — the orders CLI
 * calls the same function with its own loaded clients. */
import { NextResponse, type NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { adminSupabase, adminStripe } from '@/lib/admin/clients';
import { parseOrderIdBody } from '@/lib/admin/route-helpers';
import { refundOrder } from '@/lib/admin/actions';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // Resolved before touching Stripe: if the Cloudflare context is broken we
  // must find out before money moves, not after.
  const { env } = getCloudflareContext();
  const parsed = await parseOrderIdBody(req);
  if (!parsed.ok) return parsed.res;

  const result = await refundOrder({ supabase: adminSupabase(), stripe: adminStripe(), env }, parsed.orderId);
  return NextResponse.json(result.body, { status: result.status });
}
