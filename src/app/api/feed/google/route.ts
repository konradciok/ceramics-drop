import { NextResponse } from 'next/server';
import {
  buildGoogleFeedItems,
  buildGoogleXml,
  EU_FEED_LOCALES,
  FEED_LOCALES,
  isGoogleFeedMarketId,
  type FeedLocale,
} from '@/lib/feed';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const market = new URL(request.url).searchParams.get('market');
  if (!isGoogleFeedMarketId(market)) {
    return NextResponse.json({ error: 'invalid_market' }, { status: 400 });
  }
  const localeParam = new URL(request.url).searchParams.get('locale');
  const locale = localeParam as FeedLocale | null;
  const validLocale = locale === null
    || (market === 'eu' && (EU_FEED_LOCALES as string[]).includes(locale))
    || (market === 'pl' && locale === 'pl')
    || (market === 'gb' && locale === 'en');
  if (!validLocale || (locale !== null && !(FEED_LOCALES as string[]).includes(locale))) {
    return NextResponse.json({ error: 'invalid_market_locale' }, { status: 400 });
  }
  const contentLocale: FeedLocale = locale ?? (market === 'pl' ? 'pl' : 'en');

  try {
    // Prints only — no ceramic inventory read is needed here (see lib/feed.ts).
    const items = await buildGoogleFeedItems(market, contentLocale);
    const xml = buildGoogleXml(items, contentLocale);

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'feed_failed' }, { status: 500 });
  }
}
