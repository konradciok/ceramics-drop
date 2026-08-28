import type { Locale } from '@/i18n/routing';
import type { CategorySlug } from '@/lib/types';

export const CMS_LOCALES = ['pl', 'en', 'es', 'de'] as const satisfies readonly Locale[];

export type CmsLocale = (typeof CMS_LOCALES)[number];

export const CMS_DOCUMENT_KINDS = [
  'product_notes',
  'collection',
  'page',
  'notice',
] as const;

export type CmsDocumentKind = (typeof CMS_DOCUMENT_KINDS)[number];

export type ProductNotesSlug = CategorySlug;

export type CmsDocumentStatus = 'draft' | 'published' | 'archived';
export type CmsVersionStatus = 'draft' | 'published';

// Notes are keyed by product/design id, NOT array position. The catalogue's
// display order/num can shift via the inventory-review diff, but ids are stable
// tokens — keying by id keeps a persisted payload assigned to the right piece
// after a reorder (an array would silently mis-assign copy). See AGENTS.md.
export type ProductNotesPayload = {
  notes: Record<string, string>;
};

export type CollectionCopyPayload = {
  eyebrow: string;
  title: string;
  lead: string;
  metaDescription: string;
};

export const PRINT_PDP_SLUG = 'print-pdp';

/** Fixed-schema content for the fine-art-print PDP sections. Empty string =
    section intentionally disabled by the admin (deliberate departure from the
    min(1) rule other CMS schemas use). */
export type PrintPdpPayload = {
  artist: { name: string; bio: string };
  accordions: {
    productDetails: string;
    framing: string;
    shipping: string;
  };
};

export const HOME_PAGE_SLUG = 'home';

/** A single hero media slot: a static image, a video with its poster image, or
    absent (null — the storefront falls back to a static default). */
export type HeroMediaSlot =
  | { kind: 'image'; key: string; width: number; height: number }
  | { kind: 'video'; key: string; poster: { key: string; width: number; height: number } }
  | null;

/** Fixed-shape content for the homepage hero. */
export type HomePagePayload = {
  heroLine1: string;
  heroLine2: string;
  heroTagline: string;
  ctaLabel: string;
  heroAlt: string;
  media: { desktop: HeroMediaSlot; mobile: HeroMediaSlot };
};

export type CmsPayload =
  | ProductNotesPayload
  | CollectionCopyPayload
  | PrintPdpPayload
  | HomePagePayload
  | Record<string, unknown>;

export type CmsDocumentRef = {
  kind: CmsDocumentKind;
  slug: string;
};

export type CmsDocumentRow = CmsDocumentRef & {
  id: string;
  status: CmsDocumentStatus;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

export type CmsVersionRow<TPayload = CmsPayload> = {
  id: string;
  document_id: string;
  locale: CmsLocale;
  version: number;
  status: CmsVersionStatus;
  payload: TPayload;
  created_by: string | null;
  created_at: string;
};

export type CmsAuditRow = {
  id: string;
  document_id: string | null;
  actor_email: string | null;
  action: string;
  locale: CmsLocale | null;
  before: CmsPayload | null;
  after: CmsPayload | null;
  created_at: string;
};
