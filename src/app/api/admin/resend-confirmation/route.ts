/* LOCAL-ONLY admin route: re-send the customer order-confirmation email. Thin
 * HTTP adapter over `resendOrderConfirmation()` in src/lib/admin/actions.ts —
 * the orders CLI calls the same function with its own loaded clients. */
import { NextResponse, type NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { adminSupabase } from '@/lib/admin/clients';
import { parseOrderIdBody } from '@/lib/admin/route-helpers';
import { resendOrderConfirmation } from '@/lib/admin/actions';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext();
  const parsed = await parseOrderIdBody(req);
  if (!parsed.ok) return parsed.res;

  const result = await resendOrderConfirmation({ supabase: adminSupabase(), env }, parsed.orderId);
  return NextResponse.json(result.body, { status: result.status });
}
