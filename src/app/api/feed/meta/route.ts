import { NextResponse } from 'next/server';
import { getSoldIds, getShowroomIds } from '@/lib/inventory';
import { buildFeedItemsCms, buildMetaXml, FEED_LOCALES, type FeedLocale } from '@/lib/feed';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const param = new URL(request.url).searchParams.get('locale');
  if (param !== null && !(FEED_LOCALES as string[]).includes(param)) {
    return NextResponse.json({ error: 'invalid_locale' }, { status: 400 });
  }
  const locale: FeedLocale = (param as FeedLocale) ?? 'pl';

  try {
    const [soldIds, showroomIds] = await Promise.all([getSoldIds(), getShowroomIds()]);
    const items = await buildFeedItemsCms(locale, new Set(soldIds), new Set(showroomIds));
    const xml = buildMetaXml(items, locale);

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
