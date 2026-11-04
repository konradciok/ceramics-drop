import { NextResponse } from 'next/server';
import {
  buildFeedItems,
  buildGoogleFeedItems,
  buildMetaXml,
  EU_FEED_LOCALES,
  FEED_LOCALES,
  isGoogleFeedMarketId,
  type FeedLocale,
} from '@/lib/feed';

export const dynamic = 'force-dynamic';

const XML_HEADERS = {
  'Content-Type': 'application/xml; charset=utf-8',
  'Cache-Control': 'no-store',
};

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const param = searchParams.get('locale');
  const market = searchParams.get('market');
  if (param !== null && !(FEED_LOCALES as string[]).includes(param)) {
    return NextResponse.json({ error: 'invalid_locale' }, { status: 400 });
  }
  const locale: FeedLocale = (param as FeedLocale) ?? 'pl';

  // Market URLs share the Google feed's currency contract (e.g.
  // `?market=eu&locale=en` = English copy priced in EUR). The locale-only URL
  // keeps its legacy per-locale currency for existing catalog sources.
  if (market !== null) {
    if (!isGoogleFeedMarketId(market)) {
      return NextResponse.json({ error: 'invalid_market' }, { status: 400 });
    }
    const validLocale = param === null
      || (market === 'eu' && (EU_FEED_LOCALES as readonly string[]).includes(param))
      || (market === 'pl' && param === 'pl')
      || (market === 'gb' && param === 'en');
    if (!validLocale) {
      return NextResponse.json({ error: 'invalid_market_locale' }, { status: 400 });
    }
    const contentLocale: FeedLocale = param === null ? (market === 'pl' ? 'pl' : 'en') : locale;
    try {
      const items = await buildGoogleFeedItems(market, contentLocale);
      return new Response(buildMetaXml(items, contentLocale), { headers: XML_HEADERS });
    } catch {
      return NextResponse.json({ error: 'feed_failed' }, { status: 500 });
    }
  }

  try {
    // Prints only — no ceramic inventory read is needed here (see lib/feed.ts).
    const items = await buildFeedItems(locale);
    const xml = buildMetaXml(items, locale);

    return new Response(xml, { headers: XML_HEADERS });
  } catch {
    return NextResponse.json({ error: 'feed_failed' }, { status: 500 });
  }
}
