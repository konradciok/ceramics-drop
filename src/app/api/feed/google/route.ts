import { NextResponse } from 'next/server';
import {
  buildFeedItems,
  buildGoogleFeedItems,
  buildGoogleXml,
  EU_FEED_LOCALES,
  FEED_LOCALES,
  isGoogleFeedMarketId,
  type FeedLocale,
} from '@/lib/feed';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const market = searchParams.get('market');
  const localeParam = searchParams.get('locale');

  // Existing Merchant data sources use the locale-only URL. Keep those feeds
  // available until each source has been deliberately moved to a market URL.
  if (market === null) {
    if (localeParam !== null && !(FEED_LOCALES as string[]).includes(localeParam)) {
      return NextResponse.json({ error: 'invalid_locale' }, { status: 400 });
    }
    const locale: FeedLocale = (localeParam as FeedLocale | null) ?? 'pl';

    try {
      const items = await buildFeedItems(locale);
      const xml = buildGoogleXml(items, locale);
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

  if (!isGoogleFeedMarketId(market)) {
    return NextResponse.json({ error: 'invalid_market' }, { status: 400 });
  }
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
