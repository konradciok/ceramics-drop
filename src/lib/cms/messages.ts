import { getPublishedContent, getPreviewContent } from './server';
import { productNoteEntries } from './schemas';
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
 * aligned to stable source noteIndex values, so a display-order change cannot
 * change which copy belongs to a product ID.
 */
export function fallbackProductNotes(slug: string, locale: CmsLocale): Record<string, string> {
  const arr = (LOCALE_MESSAGES[locale].notes as Record<string, string[]>)[slug];
  const entries = productNoteEntries(slug) ?? [];
  const out: Record<string, string> = {};
  for (const { id, noteIndex } of entries) out[id] = Array.isArray(arr) ? arr[noteIndex] ?? '' : '';
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
  // Per-id merge (both branches): reads are lenient, so a design added after
  // the draft/publish keeps its committed note instead of rendering empty.
  const fallback = fallbackProductNotes(slug, locale);
  if (preview) return { ...fallback, ...preview.notes };

  const published = await getPublishedContent<ProductNotesPayload>('product_notes', slug, locale);
  return published ? { ...fallback, ...published.notes } : fallback;
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
