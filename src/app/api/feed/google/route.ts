import { getSoldIds } from '@/lib/inventory';
import { buildFeedItems, buildGoogleXml, type FeedLocale } from '@/lib/feed';

export const dynamic = 'force-dynamic';

const VALID_LOCALES: FeedLocale[] = ['pl', 'en', 'es', 'de', 'gb'];

export async function GET(request: Request) {
  const param = new URL(request.url).searchParams.get('locale') ?? 'pl';
  const locale: FeedLocale = (VALID_LOCALES as string[]).includes(param)
    ? (param as FeedLocale)
    : 'pl';

  const soldIds = new Set(await getSoldIds());
  const items = buildFeedItems(locale, soldIds);
  const xml = buildGoogleXml(items, locale);

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
