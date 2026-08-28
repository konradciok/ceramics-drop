import { getPublishedContent, getPreviewContent } from './server';
import { LOCALE_MESSAGES } from './messages';
import { HOME_PAGE_SLUG, type CmsLocale, type HomePagePayload } from './types';

/** Fallback copy from messages/*.json — used when no CMS document is published.
    No media (no default hero image/video is baked into the CMS layer here);
    the storefront supplies its own static default when both slots are null. */
export function fallbackHomePayload(locale: CmsLocale): HomePagePayload {
  const m = LOCALE_MESSAGES[locale].home;
  return {
    heroLine1: m.heroLine1,
    heroLine2: m.heroLine2,
    heroTagline: m.heroTagline,
    ctaLabel: m.heroCta,
    heroAlt: m.heroAlt,
    media: { desktop: null, mobile: null },
  };
}

/**
 * Homepage hero content: preview draft (valid ?preview= token) > published
 * CMS payload > messages fallback. Read errors fall back (a CMS outage must
 * never break the homepage).
 */
export async function getHomeContent(
  locale: CmsLocale,
  previewToken?: string | null,
): Promise<HomePagePayload> {
  const preview = await getPreviewContent<HomePagePayload>(previewToken, {
    kind: 'page',
    slug: HOME_PAGE_SLUG,
    locale,
  });
  if (preview) return preview;

  const published = await getPublishedContent<HomePagePayload>('page', HOME_PAGE_SLUG, locale);
  return published ?? fallbackHomePayload(locale);
}
