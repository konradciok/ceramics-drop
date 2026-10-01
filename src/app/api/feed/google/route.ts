import { NextResponse } from 'next/server';
import { buildGoogleFeedItems, buildGoogleXml, isGoogleFeedMarketId, type GoogleFeedMarketId } from '@/lib/feed';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const market = new URL(request.url).searchParams.get('market');
  if (!isGoogleFeedMarketId(market)) {
    return NextResponse.json({ error: 'invalid_market' }, { status: 400 });
  }

  try {
    // Prints only — no ceramic inventory read is needed here (see lib/feed.ts).
    const items = await buildGoogleFeedItems(market);
    const xml = buildGoogleXml(items, market === 'pl' ? 'pl' : 'en');

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
