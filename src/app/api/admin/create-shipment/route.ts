/* LOCAL-ONLY admin route: retry InPost shipment creation for a paid order.
 * Thin HTTP adapter over `createShipmentForOrder()` in src/lib/admin/actions.ts
 * — the orders CLI calls the same function with its own loaded clients. */
import { NextResponse, type NextRequest } from 'next/server';
import { adminSupabase } from '@/lib/admin/clients';
import { isUuid } from '@/lib/admin/data';
import { getInPost } from '@/lib/inpost';
import { createShipmentForOrder } from '@/lib/admin/actions';

export const dynamic = 'force-dynamic';

type CreateShipmentBody = { orderId?: string; recreate?: boolean };

export async function POST(req: NextRequest) {
  let body: CreateShipmentBody;
  try {
    body = (await req.json()) as CreateShipmentBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const orderId = body.orderId;
  if (!isUuid(orderId)) {
    return NextResponse.json({ error: 'Valid orderId required' }, { status: 400 });
  }

  const result = await createShipmentForOrder(
    { supabase: adminSupabase(), inpost: getInPost() },
    orderId,
    { recreate: body.recreate === true },
  );
  return NextResponse.json(result.body, { status: result.status });
}
