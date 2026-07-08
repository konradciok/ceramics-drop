import { z } from 'zod';
import { getPrintDesigns } from '@/lib/prints';
import { getProductsByCategory } from '@/lib/products';
import { CMS_DOCUMENT_KINDS, CMS_LOCALES, type CmsDocumentKind, type CmsLocale, type ProductNotesPayload } from './types';
import type { CategorySlug } from '@/lib/types';

const PRINTS_SLUG = 'fine-art-prints';

export const cmsLocaleSchema = z.enum(CMS_LOCALES);
export const cmsKindSchema = z.enum(CMS_DOCUMENT_KINDS);

const noteString = z.string().trim().min(1, 'Opis nie może być pusty');

export const productNotesBaseSchema = z.object({
  notes: z.record(z.string(), noteString),
});

const plainText = z.string().trim().min(1).refine((value) => !/[<>]/.test(value), {
  message: 'To pole obsługuje tylko zwykły tekst',
});

const titleWithEm = z.string().trim().min(1).refine((value) => {
  const withoutAllowedEm = value.replace(/<\/?em>/g, '');
  return !/[<>]/.test(withoutAllowedEm);
}, { message: 'Dozwolony jest tylko znacznik <em>' });

export const collectionCopySchema = z.object({
  eyebrow: plainText,
  title: titleWithEm,
  lead: plainText,
  metaDescription: plainText,
});

export const homePageSchema = z.object({
  heroEyebrow: plainText,
  heroTitle: titleWithEm,
  heroLead: plainText,
  ctaLabel: plainText,
});

export const studioPageSchema = z.object({
  title: titleWithEm,
  lead: plainText,
  body: plainText,
});

export const galleryPageSchema = z.object({
  title: titleWithEm,
  lead: plainText,
  captions: z.array(plainText),
  alt: z.array(plainText),
});

export const deliveryNoticeSchema = z.object({
  title: plainText,
  p1: plainText,
  p2: plainText,
  p3: plainText,
});

/** Live ids whose notes a payload must cover, in catalogue order (null = unknown slug). */
export function productNoteIds(slug: string): string[] | null {
  if (slug === PRINTS_SLUG) return getPrintDesigns().map((design) => design.id);
  try {
    return getProductsByCategory(slug as CategorySlug).map((product) => product.id);
  } catch {
    return null;
  }
}

export function validateProductNotesPayload(slug: string, payload: unknown): ProductNotesPayload {
  const parsed = productNotesBaseSchema.parse(payload);
  const ids = productNoteIds(slug);
  if (ids === null) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['slug'],
        message: `Nieznany dokument notatek: ${slug}`,
        input: slug,
      },
    ]);
  }
  const expected = new Set(ids);
  const got = new Set(Object.keys(parsed.notes));
  for (const id of expected) {
    if (!got.has(id)) {
      throw new z.ZodError([
        { code: 'custom', path: ['notes', id], message: `Brak opisu dla ${id}`, input: undefined },
      ]);
    }
  }
  for (const id of got) {
    if (!expected.has(id)) {
      throw new z.ZodError([
        { code: 'custom', path: ['notes', id], message: `Nieznany identyfikator ${id}`, input: id },
      ]);
    }
  }
  return parsed;
}

export function validateCmsPayload(kind: CmsDocumentKind, slug: string, payload: unknown): unknown {
  switch (kind) {
    case 'product_notes':
      return validateProductNotesPayload(slug, payload);
    case 'collection':
      return collectionCopySchema.parse(payload);
    case 'page':
      if (slug === 'home') return homePageSchema.parse(payload);
      if (slug === 'studio') return studioPageSchema.parse(payload);
      if (slug === 'gallery') return galleryPageSchema.parse(payload);
      throw new Error(`Unsupported page document: ${slug}`);
    case 'notice':
      if (slug === 'delivery') return deliveryNoticeSchema.parse(payload);
      throw new Error(`Unsupported notice document: ${slug}`);
  }
}

export function isCmsLocale(value: string): value is CmsLocale {
  return CMS_LOCALES.includes(value as CmsLocale);
}

export function isCmsKind(value: string): value is CmsDocumentKind {
  return CMS_DOCUMENT_KINDS.includes(value as CmsDocumentKind);
}

export function zodIssues(error: unknown): Record<string, string> {
  if (!(error instanceof z.ZodError)) return {};
  return Object.fromEntries(error.issues.map((issue) => [issue.path.join('.') || 'payload', issue.message]));
}
