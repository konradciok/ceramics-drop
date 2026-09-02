import { z } from 'zod';
import { registryPrintDesigns } from '@/lib/prints';
import { registryProductsByCategory } from '@/lib/products';
import { IMAGE_KEY_RE, VIDEO_KEY_RE } from '@/lib/site-media';
import { CMS_DOCUMENT_KINDS, CMS_LOCALES, HOME_PAGE_SLUG, PRINT_PDP_SLUG, type CmsDocumentKind, type CmsLocale, type ProductNotesPayload } from './types';
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

// Unlike plainText above, empty is legal here: publishing an empty field is
// how the admin disables a PDP section (or, for the home hero, omits an
// optional field like the tagline/alt text).
const optionalPlainText = z.string().trim().refine((value) => !/[<>]/.test(value), {
  message: 'To pole obsługuje tylko zwykły tekst',
});

export const printPdpSchema = z.object({
  artist: z.object({ name: optionalPlainText, bio: optionalPlainText }),
  accordions: z.object({
    productDetails: optionalPlainText,
    framing: optionalPlainText,
    shipping: optionalPlainText,
  }),
});

const dim = z.number().int().positive();
const imageKey = z.string().regex(IMAGE_KEY_RE, 'Nieprawidłowy klucz obrazu');
const videoKey = z.string().regex(VIDEO_KEY_RE, 'Nieprawidłowy klucz wideo');

const heroImage = z.object({ kind: z.literal('image'), key: imageKey, width: dim, height: dim });
const heroVideo = z.object({ kind: z.literal('video'), key: videoKey, poster: heroImage.omit({ kind: true }) });
const heroSlot = z.discriminatedUnion('kind', [heroImage, heroVideo]).nullable();

export const homePageSchema = z.object({
  heroLine1: plainText,
  heroLine2: plainText,
  heroTagline: optionalPlainText,
  ctaLabel: plainText,
  heroAlt: optionalPlainText,
  media: z.object({ desktop: heroSlot, mobile: heroSlot }),
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

export type ProductNoteEntry = { id: string; noteIndex: number };

/** Live note identities in catalogue order (null = unknown slug). */
export function productNoteEntries(slug: string): ProductNoteEntry[] | null {
  if (slug === PRINTS_SLUG) return registryPrintDesigns().map(({ id, noteIndex }) => ({ id, noteIndex }));
  try {
    return registryProductsByCategory(slug as CategorySlug).map(({ id, noteIndex }) => ({ id, noteIndex }));
  } catch {
    return null;
  }
}

/** Live ids whose notes a payload must cover, in catalogue order (null = unknown slug). */
export function productNoteIds(slug: string): string[] | null {
  return productNoteEntries(slug)?.map(({ id }) => id) ?? null;
}

export type ValidateCmsOptions = {
  /**
   * Read-time mode for storefront renders: stale ids (a design retired from the
   * curation after publish) are dropped and missing ids (a design added after
   * publish) are tolerated, so a catalogue change never blanks a whole
   * category's notes. Publish/save paths keep the strict default.
   */
  lenient?: boolean;
};

export function validateProductNotesPayload(slug: string, payload: unknown, options: ValidateCmsOptions = {}): ProductNotesPayload {
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
  if (options.lenient) {
    const notes = Object.fromEntries(Object.entries(parsed.notes).filter(([id]) => expected.has(id)));
    return { ...parsed, notes };
  }
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

export function validateCmsPayload(kind: CmsDocumentKind, slug: string, payload: unknown, options: ValidateCmsOptions = {}): unknown {
  switch (kind) {
    case 'product_notes':
      return validateProductNotesPayload(slug, payload, options);
    case 'collection':
      return collectionCopySchema.parse(payload);
    case 'page':
      if (slug === PRINT_PDP_SLUG) return printPdpSchema.parse(payload);
      if (slug === HOME_PAGE_SLUG) return homePageSchema.parse(payload);
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
