import { adminSupabase } from './clients';
import { CATEGORY_ORDER, CATEGORIES, getProductsByCategory } from '@/lib/products';
import { getPrintDesigns } from '@/lib/prints';
import { fallbackProductNotes } from '@/lib/cms/messages';
import { CMS_LOCALES, type CmsDocumentKind, type CmsLocale, type CmsPayload, type CmsVersionRow } from '@/lib/cms/types';
import { validateCmsPayload } from '@/lib/cms/schemas';
import type { CategorySlug } from '@/lib/types';

export type EditableContentDocument = {
  kind: CmsDocumentKind;
  slug: string;
  label: string;
  publicPath: string;
};

export const PRODUCT_NOTE_DOCUMENTS: EditableContentDocument[] = [
  ...CATEGORY_ORDER.map((slug) => ({
    kind: 'product_notes' as const,
    slug,
    label: CATEGORIES[slug].slug,
    publicPath: `/${slug}`,
  })),
  {
    kind: 'product_notes',
    slug: 'fine-art-prints',
    label: 'fine-art-prints',
    publicPath: '/fine-art-prints',
  },
];

export type ContentSummary = EditableContentDocument & {
  documentId: string | null;
  status: string;
  updatedAt: string | null;
  publishedAt: string | null;
  locales: Record<CmsLocale, { draft: boolean; published: boolean; latestVersion: number | null }>;
};

export type ContentItem = {
  id: string;
  label: string;
  image: string | null;
};

export type LocaleEditorState = {
  locale: CmsLocale;
  payload: CmsPayload;
  latestDraft: CmsVersionRow | null;
  published: CmsVersionRow | null;
  versions: CmsVersionRow[];
};

export type ContentEditorState = EditableContentDocument & {
  documentId: string | null;
  items: ContentItem[];
  locales: Record<CmsLocale, LocaleEditorState>;
};

type RawDocument = {
  id: string;
  kind: CmsDocumentKind;
  slug: string;
  status: string;
  updated_at: string;
  published_at: string | null;
  cms_document_versions?: CmsVersionRow[];
};

export function editableDocument(kind: string, slug: string): EditableContentDocument | null {
  return PRODUCT_NOTE_DOCUMENTS.find((doc) => doc.kind === kind && doc.slug === slug) ?? null;
}

export function contentItems(slug: string): ContentItem[] {
  if (slug === 'fine-art-prints') {
    return getPrintDesigns().map((design) => ({
      id: design.id,
      label: `Druk Nº ${design.num}`,
      image: design.image,
    }));
  }
  return getProductsByCategory(slug as CategorySlug).map((product) => ({
    id: product.id,
    label: `${product.category} Nº ${product.num}`,
    image: product.image,
  }));
}

function emptyLocaleState(locale: CmsLocale, slug: string): LocaleEditorState {
  return {
    locale,
    payload: { notes: fallbackProductNotes(slug, locale) },
    latestDraft: null,
    published: null,
    versions: [],
  };
}

function localeState(locale: CmsLocale, slug: string, versions: CmsVersionRow[]): LocaleEditorState {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const latestDraft = sorted.find((v) => v.status === 'draft') ?? null;
  const published = sorted.find((v) => v.status === 'published') ?? null;
  return {
    locale,
    payload: latestDraft?.payload ?? published?.payload ?? { notes: fallbackProductNotes(slug, locale) },
    latestDraft,
    published,
    versions: sorted,
  };
}

async function getRawDocument(kind: CmsDocumentKind, slug: string): Promise<RawDocument | null> {
  const supabase = adminSupabase();
  const { data, error } = await supabase
    .from('cms_documents')
    .select('id, kind, slug, status, updated_at, published_at, cms_document_versions(id, document_id, locale, version, status, payload, created_by, created_at)')
    .eq('kind', kind)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return (data as RawDocument | null) ?? null;
}

export async function listContentSummaries(status?: string): Promise<ContentSummary[]> {
  const supabase = adminSupabase();
  const { data, error } = await supabase
    .from('cms_documents')
    .select('id, kind, slug, status, updated_at, published_at, cms_document_versions(locale, version, status)')
    .eq('kind', 'product_notes');
  if (error) throw error;

  const byKey = new Map(((data as RawDocument[] | null) ?? []).map((row) => [`${row.kind}:${row.slug}`, row]));

  return PRODUCT_NOTE_DOCUMENTS.map((doc) => {
    const row = byKey.get(`${doc.kind}:${doc.slug}`) ?? null;
    const locales = Object.fromEntries(CMS_LOCALES.map((locale) => {
      const versions = ((row?.cms_document_versions ?? []) as CmsVersionRow[]).filter((v) => v.locale === locale);
      return [locale, {
        draft: versions.some((v) => v.status === 'draft'),
        published: versions.some((v) => v.status === 'published'),
        latestVersion: versions.reduce<number | null>((max, v) => Math.max(max ?? 0, v.version), null),
      }];
    })) as ContentSummary['locales'];
    const summary: ContentSummary = {
      ...doc,
      documentId: row?.id ?? null,
      status: row?.status ?? 'missing',
      updatedAt: row?.updated_at ?? null,
      publishedAt: row?.published_at ?? null,
      locales,
    };
    return summary;
  }).filter((doc) => {
    if (!status || status === 'all') return true;
    if (status === 'missing') return doc.status === 'missing';
    return doc.status === status;
  });
}

export async function getContentEditorState(kind: CmsDocumentKind, slug: string): Promise<ContentEditorState | null> {
  const doc = editableDocument(kind, slug);
  if (!doc) return null;
  const row = await getRawDocument(kind, slug);
  const versions = (row?.cms_document_versions ?? []) as CmsVersionRow[];
  const locales = Object.fromEntries(CMS_LOCALES.map((locale) => [
    locale,
    row ? localeState(locale, slug, versions.filter((v) => v.locale === locale)) : emptyLocaleState(locale, slug),
  ])) as ContentEditorState['locales'];
  return {
    ...doc,
    documentId: row?.id ?? null,
    items: contentItems(slug),
    locales,
  };
}

async function ensureDocument(kind: CmsDocumentKind, slug: string): Promise<string> {
  const supabase = adminSupabase();
  const existing = await getRawDocument(kind, slug);
  if (existing) return existing.id;
  const { data, error } = await supabase
    .from('cms_documents')
    .insert({ kind, slug, status: 'draft' })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function nextVersion(documentId: string, locale: CmsLocale): Promise<number> {
  const supabase = adminSupabase();
  const { data, error } = await supabase
    .from('cms_document_versions')
    .select('version')
    .eq('document_id', documentId)
    .eq('locale', locale)
    .order('version', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (((data as Array<{ version: number }> | null)?.[0]?.version ?? 0) + 1);
}

export async function saveDraft(params: {
  kind: CmsDocumentKind;
  slug: string;
  locale: CmsLocale;
  payload: unknown;
  actorEmail?: string | null;
}): Promise<CmsVersionRow> {
  if (!editableDocument(params.kind, params.slug)) throw new Error('unsupported_document');
  const payload = validateCmsPayload(params.kind, params.slug, params.payload);
  const supabase = adminSupabase();
  const documentId = await ensureDocument(params.kind, params.slug);
  const version = await nextVersion(documentId, params.locale);
  const { data, error } = await supabase
    .from('cms_document_versions')
    .insert({
      document_id: documentId,
      locale: params.locale,
      version,
      status: 'draft',
      payload,
      created_by: params.actorEmail ?? null,
    })
    .select('id, document_id, locale, version, status, payload, created_by, created_at')
    .single();
  if (error) throw error;
  await supabase.from('cms_documents').update({ updated_at: new Date().toISOString() }).eq('id', documentId);
  await supabase.from('cms_audit_log').insert({
    document_id: documentId,
    actor_email: params.actorEmail ?? null,
    action: 'draft_saved',
    locale: params.locale,
    before: null,
    after: payload,
  });
  return data as CmsVersionRow;
}

export async function publishVersion(params: {
  kind: CmsDocumentKind;
  slug: string;
  locale: CmsLocale;
  version: number;
  actorEmail?: string | null;
}): Promise<CmsVersionRow> {
  if (!editableDocument(params.kind, params.slug)) throw new Error('unsupported_document');
  const row = await getRawDocument(params.kind, params.slug);
  if (!row) throw new Error('document_not_found');

  const versions = (row.cms_document_versions ?? []) as CmsVersionRow[];
  const target = versions.find((v) => v.locale === params.locale && v.version === params.version);
  if (!target) throw new Error('version_not_found');
  validateCmsPayload(params.kind, params.slug, target.payload);

  const previous = versions.find((v) => v.locale === params.locale && v.status === 'published') ?? null;

  // Atomic publish: demote old published → promote target → mark doc published,
  // in one Postgres transaction under a document-level FOR UPDATE lock (see
  // migration publish_cms_version). The storefront already falls back per-locale
  // when a locale has no published version, so only the requested locale is gated.
  const supabase = adminSupabase();
  const { data, error } = await supabase.rpc('publish_cms_version', {
    p_document_id: row.id,
    p_locale: params.locale,
    p_version: params.version,
  });
  if (error) throw error;
  const promoted = ((data as CmsVersionRow[] | null) ?? [])[0];
  if (!promoted) throw new Error('version_not_found');

  await supabase.from('cms_audit_log').insert({
    document_id: row.id,
    actor_email: params.actorEmail ?? null,
    action: 'published',
    locale: params.locale,
    before: previous?.payload ?? null,
    after: target.payload,
  });

  return promoted;
}

export async function revertVersion(params: {
  kind: CmsDocumentKind;
  slug: string;
  locale: CmsLocale;
  version: number;
  actorEmail?: string | null;
}): Promise<CmsVersionRow> {
  if (!editableDocument(params.kind, params.slug)) throw new Error('unsupported_document');
  const row = await getRawDocument(params.kind, params.slug);
  if (!row) throw new Error('document_not_found');
  const source = ((row.cms_document_versions ?? []) as CmsVersionRow[]).find(
    (v) => v.locale === params.locale && v.version === params.version,
  );
  if (!source) throw new Error('version_not_found');
  const draft = await saveDraft({
    kind: params.kind,
    slug: params.slug,
    locale: params.locale,
    payload: source.payload,
    actorEmail: params.actorEmail,
  });
  const supabase = adminSupabase();
  await supabase.from('cms_audit_log').insert({
    document_id: row.id,
    actor_email: params.actorEmail ?? null,
    action: 'reverted',
    locale: params.locale,
    before: null,
    after: source.payload,
  });
  return draft;
}
