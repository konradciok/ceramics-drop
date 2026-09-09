import { NextResponse } from 'next/server';
import { RETURNS_POLICY, returnContactHref } from '@/lib/returns-policy';

export const dynamic = 'force-dynamic';

/** Retired label endpoint. No order lookup, paid label or customer email is
 * created. Existing return shipments remain in the order history. */
export async function POST() {
  return NextResponse.json({
    error: 'return_labels_retired',
    contact: RETURNS_POLICY.email,
    contact_url: returnContactHref('Return / Zwrot'),
    return_address: RETURNS_POLICY.address,
    account_required: false,
  }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
}
