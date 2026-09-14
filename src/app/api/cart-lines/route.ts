import { NextResponse } from 'next/server';
import { resolveCartLinesServer } from '@/lib/cart-lines-server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/cart-lines?ids=a,b,c — server-side, DB-aware resolution of cart
 * ids to renderable line data (name/image/price inputs, not the price
 * itself — currency-dependent price display stays client-side, same as
 * before). Display only: checkout's own validateCart() remains the sole
 * authority for what may actually be purchased, so a bug here can show a
 * wrong price/name but can never let an invalid purchase through.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('ids');
  const ids = raw ? raw.split(',').filter((id) => id !== '') : [];
  if (ids.length === 0) {
    return NextResponse.json(
      { error: 'ids required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const lines = await resolveCartLinesServer(ids);
  return NextResponse.json({ lines }, { headers: { 'Cache-Control': 'no-store' } });
}
