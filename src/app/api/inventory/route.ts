import { NextResponse } from 'next/server';
import { getSoldIds } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sold = await getSoldIds();
  return NextResponse.json(
    { sold },
    { headers: { 'Cache-Control': 'public, max-age=30' } },
  );
}
