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

export type ProductNotesPayload = {
  notes: string[];
};

export type CollectionCopyPayload = {
  eyebrow: string;
  title: string;
  lead: string;
  metaDescription: string;
};

export type CmsPayload = ProductNotesPayload | CollectionCopyPayload | Record<string, unknown>;

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
