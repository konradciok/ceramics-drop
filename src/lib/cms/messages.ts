import { getPublishedContent, getPreviewContent } from './server';
import { productNoteIds } from './schemas';
import type { CmsLocale, ProductNotesPayload } from './types';

import plMessages from '../../../messages/pl.json';
import enMessages from '../../../messages/en.json';
import esMessages from '../../../messages/es.json';
import deMessages from '../../../messages/de.json';

type Messages = typeof enMessages;

export const LOCALE_MESSAGES: Record<CmsLocale, Messages> = {
  pl: plMessages as unknown as Messages,
  en: enMessages,
  es: esMessages as unknown as Messages,
  de: deMessages as unknown as Messages,
};

/**
 * Fallback notes as id→text. messages.json stores them as a position array
 * (aligned to noteIndex); we zip that against the live registry ids here so the
 * fallback stays id-keyed like the CMS payload. Position↔id correspondence is
 * stable because both the array and the registry are regenerated together.
 */
export function fallbackProductNotes(slug: string, locale: CmsLocale): Record<string, string> {
  const arr = (LOCALE_MESSAGES[locale].notes as Record<string, string[]>)[slug];
  const ids = productNoteIds(slug) ?? [];
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length; i++) out[ids[i]] = Array.isArray(arr) ? arr[i] ?? '' : '';
  return out;
}

export async function getProductNotes(
  slug: string,
  locale: CmsLocale,
  previewToken?: string | null,
): Promise<Record<string, string>> {
  const preview = await getPreviewContent<ProductNotesPayload>(previewToken, {
    kind: 'product_notes',
    slug,
    locale,
  });
  if (preview) return preview.notes;

  const published = await getPublishedContent<ProductNotesPayload>('product_notes', slug, locale);
  return published?.notes ?? fallbackProductNotes(slug, locale);
}

export async function getProductNote(
  slug: string,
  locale: CmsLocale,
  productId: string,
  previewToken?: string | null,
): Promise<string> {
  const notes = await getProductNotes(slug, locale, previewToken);
  return notes[productId] ?? '';
}
