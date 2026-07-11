/* Admin route: free pieces stuck in `reserved` for an order (e.g. an abandoned
 * checkout whose hold never expired). Thin HTTP adapter over
 * `releaseReservation()` in src/lib/admin/actions.ts — the orders CLI calls
 * the same function with its own loaded clients. */
import { NextResponse, type NextRequest } from 'next/server';
import { adminSupabase, adminStripe } from '@/lib/admin/clients';
import { parseOrderIdBody } from '@/lib/admin/route-helpers';
import { releaseReservation } from '@/lib/admin/actions';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const parsed = await parseOrderIdBody(req);
  if (!parsed.ok) return parsed.res;

  const result = await releaseReservation({ supabase: adminSupabase(), stripe: adminStripe() }, parsed.orderId);
  return NextResponse.json(result.body, { status: result.status });
}
