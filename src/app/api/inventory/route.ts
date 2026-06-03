import { NextResponse } from 'next/server';
import { getSoldIds } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sold = await getSoldIds();
    return NextResponse.json(
      { sold },
      { headers: { 'Cache-Control': 'public, max-age=30' } },
    );
  } catch {
    // Best-effort cart pruning: on a Supabase outage return an empty list
    // (don't cache the failure) rather than 500-ing the cart's prune fetch.
    return NextResponse.json(
      { sold: [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
