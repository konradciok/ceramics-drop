import { NextResponse } from 'next/server';
import { getPublicProducts } from '@/lib/products';
import { getCeramicSaleState } from '@/lib/ceramic-sale-state';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [products, state] = await Promise.all([getPublicProducts(), getCeramicSaleState()]);
    if (state.failed) throw new Error('availability_unavailable');
    return NextResponse.json(
      {
        sold: products.filter((p) => p.sold).map((p) => p.id),
        showroom: products.filter((p) => p.showroom).map((p) => p.id),
        available: products.filter((p) => p.onlineAvailable === true).map((p) => p.id),
        activeDrops: state.drops.filter((d) => d.status === 'active').map((d) => d.id),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    // Never turn an outage into a claim that every piece is available.
    return NextResponse.json(
      { error: 'availability_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
