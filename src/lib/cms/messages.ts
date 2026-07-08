import { getPublishedContent, getPreviewContent } from './server';
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

export function fallbackProductNotes(slug: string, locale: CmsLocale): string[] {
  const notes = (LOCALE_MESSAGES[locale].notes as Record<string, string[]>)[slug];
  return Array.isArray(notes) ? notes : [];
}

export async function getProductNotes(
  slug: string,
  locale: CmsLocale,
  previewToken?: string | null,
): Promise<string[]> {
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
  noteIndex: number,
  previewToken?: string | null,
): Promise<string> {
  const notes = await getProductNotes(slug, locale, previewToken);
  return notes[noteIndex] ?? '';
}
