import { NextResponse } from 'next/server';
import { PRINT_SHOP_URL } from '@/lib/site';

export const dynamic = 'force-dynamic';

/**
 * Retired merchant feed. It only ever listed fine-art prints, which moved to
 * their own shop (PRINT_SHOP_URL, 2026-11) — ceramics were deliberately never
 * in it (one-of-a-kind ⇒ unavoidable availability mismatch). 410 Gone tells
 * the scheduled Merchant Center / Meta Catalog fetches the source is gone for
 * good rather than temporarily failing.
 */
export function GET() {
  return NextResponse.json(
    { error: 'feed_retired', moved_to: PRINT_SHOP_URL },
    { status: 410, headers: { 'Cache-Control': 'no-store' } },
  );
}
