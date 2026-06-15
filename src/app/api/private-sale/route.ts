import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { loadActivePrivateSale, normalizeToken } from '@/lib/private-sale';

export const dynamic = 'force-dynamic';

/**
 * Resolve a private-sale token to its product ids so the cart can seed itself
 * from the link. Single source of truth for what a link contains. Invalid /
 * expired / consumed / unknown tokens all return a uniform 404 (no enumeration).
 */
export async function GET(req: Request) {
  // `no-store` on the negative path too: a transient backend blip must not get a 404
  // cached and then block a later retry with a valid token.
  const notFound = () =>
    NextResponse.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });

  const token = normalizeToken(new URL(req.url).searchParams.get('token'));
  if (!token) return notFound();

  try {
    const sale = await loadActivePrivateSale(getSupabaseAdmin(), token);
    if (!sale) return notFound();
    return NextResponse.json(
      { product_ids: sale.product_ids },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return notFound();
  }
}
