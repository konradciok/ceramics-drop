import { getSoldIds } from '@/lib/inventory';
import { buildFeedItems, buildMetaXml, FEED_LOCALES, type FeedLocale } from '@/lib/feed';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const param = new URL(request.url).searchParams.get('locale') ?? 'pl';
  const locale: FeedLocale = (FEED_LOCALES as string[]).includes(param)
    ? (param as FeedLocale)
    : 'pl';

  const soldIds = new Set(await getSoldIds());
  const items = buildFeedItems(locale, soldIds);
  const xml = buildMetaXml(items, locale);

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
