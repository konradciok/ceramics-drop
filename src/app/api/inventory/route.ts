import { NextResponse } from 'next/server';
import { getSoldIds, getShowroomIds } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [sold, showroom] = await Promise.all([getSoldIds(), getShowroomIds()]);
    return NextResponse.json(
      { sold, showroom },
      { headers: { 'Cache-Control': 'public, max-age=30' } },
    );
  } catch {
    // Best-effort cart pruning: on a Supabase outage return empty lists
    // (don't cache the failure) rather than 500-ing the cart's prune fetch.
    return NextResponse.json(
      { sold: [], showroom: [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
