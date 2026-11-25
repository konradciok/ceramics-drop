import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import {
  buildMetaFeedItems,
  buildMetaFeedXml,
  META_FEED_LOCALES,
  MetaFeedUnavailableError,
  resolveMetaFeedCurrency,
  type MetaFeedLocale,
} from '@/lib/meta-catalog-feed';
import { DEGRADED_RETRY_AFTER_SECONDS } from '@/lib/request-degradation';

export const dynamic = 'force-dynamic';

/**
 * Meta Commerce Manager catalogue feed — ceramics purchasable right now
 * (see src/lib/meta-catalog-feed.ts). `?locale=pl|en|es|de` picks the copy and
 * landing page; `?currency=` the price (pl → pln only; en/es/de → eur default
 * or gbp). The retired `/api/feed/meta` stays 410 for the old print sources.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const localeParam = params.get('locale') ?? 'pl';
  if (!(META_FEED_LOCALES as readonly string[]).includes(localeParam)) {
    return NextResponse.json({ error: 'invalid_locale' }, { status: 400 });
  }
  const locale = localeParam as MetaFeedLocale;
  const currency = resolveMetaFeedCurrency(locale, params.get('currency'));
  if (!currency) {
    return NextResponse.json({ error: 'invalid_currency' }, { status: 400 });
  }

  try {
    const items = await buildMetaFeedItems(locale, currency);
    return new Response(buildMetaFeedXml(items, locale), {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  } catch (error) {
    // Never answer an empty 200: Meta would delete every catalogue item.
    if (!(error instanceof MetaFeedUnavailableError)) {
      Sentry.captureException(error, { tags: { feed: 'meta-ceramics' } });
    }
    console.error('[meta-ceramics-feed] feed unavailable', error);
    return NextResponse.json(
      { error: 'feed_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(DEGRADED_RETRY_AFTER_SECONDS) } },
    );
  }
}
