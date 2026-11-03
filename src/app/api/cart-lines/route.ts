import { NextResponse } from 'next/server';
import { resolveCartLinesServer } from '@/lib/cart-lines-server';
import type { Locale } from '@/i18n/routing';

export const dynamic = 'force-dynamic';

const VALID_LOCALES: Locale[] = ['pl', 'en', 'es', 'de'];

/**
 * GET /api/cart-lines?ids=a,b,c&locale=pl — server-side, DB-aware resolution of cart
 * ids to renderable line data (name/image/price inputs, not the price
 * itself — currency-dependent price display stays client-side, same as
 * before). Display only: checkout's own validateCart() remains the sole
 * authority for what may actually be purchased, so a bug here can show a
 * wrong price/name but can never let an invalid purchase through.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const raw = params.get('ids');
  const localeParam = params.get('locale');
  if (localeParam !== null && !(VALID_LOCALES as string[]).includes(localeParam)) {
    return NextResponse.json(
      { error: 'invalid_locale' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const locale: Locale = (localeParam as Locale) ?? 'pl';

  const ids = raw ? raw.split(',').filter((id) => id !== '') : [];
  if (ids.length === 0) {
    return NextResponse.json(
      { error: 'ids required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const lines = await resolveCartLinesServer(ids, locale);
  return NextResponse.json({ lines }, { headers: { 'Cache-Control': 'no-store' } });
}
