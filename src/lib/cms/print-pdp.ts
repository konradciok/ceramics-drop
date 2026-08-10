import { getPublishedContent, getPreviewContent } from './server';
import { LOCALE_MESSAGES } from './messages';
import { PRINT_PDP_SLUG, type CmsLocale, type PrintPdpPayload } from './types';

/** Fallback copy from messages/*.json — used when no CMS document is published. */
export function fallbackPrintPdpPayload(locale: CmsLocale): PrintPdpPayload {
  const m = LOCALE_MESSAGES[locale].printPdp;
  return {
    artist: { name: m.artistName, bio: m.artistBio },
    accordions: {
      productDetails: m.accordionProductDetails,
      framing: m.accordionFraming,
      shipping: m.accordionShipping,
    },
  };
}

/** Blank-line-separated plain text → paragraph list (single \n stays inline). */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Print-PDP section content: preview draft (valid ?preview= token) > published
 * CMS payload > messages fallback. A published payload wins even when a field
 * is empty — an intentionally emptied field HIDES its section rather than
 * resurrecting fallback copy. Read errors fall back (never break the PDP).
 */
export async function getPrintPdpContent(
  locale: CmsLocale,
  previewToken?: string | null,
): Promise<PrintPdpPayload> {
  const preview = await getPreviewContent<PrintPdpPayload>(previewToken, {
    kind: 'page',
    slug: PRINT_PDP_SLUG,
    locale,
  });
  if (preview) return preview;

  const published = await getPublishedContent<PrintPdpPayload>('page', PRINT_PDP_SLUG, locale);
  return published ?? fallbackPrintPdpPayload(locale);
}
