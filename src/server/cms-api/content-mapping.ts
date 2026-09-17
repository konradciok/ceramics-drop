import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EDITABLE_DOCUMENTS,
  editableDocument,
  getContentEditorState,
} from '@/lib/admin/content';
import type { ContentEditorState, ContentItem, LocaleEditorState } from '@/lib/admin/content';
import { CMS_LOCALES, HOME_PAGE_SLUG, PRINT_PDP_SLUG } from '@/lib/cms/types';
import type { CmsDocumentKind, CmsLocale, CmsPayload, HomePagePayload, PrintPdpPayload, ProductNotesPayload } from '@/lib/cms/types';
import type { Field } from './types';

// ---------------------------------------------------------------------------
// Resource shape
// ---------------------------------------------------------------------------

// Same generic Resource shape as CollectionResponse (types.ts) — `kind:
// 'content'` is the only difference at the wire level. Defined here rather
// than in types.ts because it is exclusively produced/consumed by this
// module and its handlers (mirrors how collections-mapping.ts owns
// CollectionResponse's construction even though the type itself lives in
// types.ts — kept local here instead since nothing outside content-*.ts
// needs to import it).
export type ContentResponse = {
  id: string;
  kind: 'content';
  name: string;
  revision: number;
  publishedRevision: number | null;
  fields: Field[];
};

export type ContentDocumentRef = { kind: CmsDocumentKind; slug: string };

// ---------------------------------------------------------------------------
// Resource id encode/decode — locale is part of resource identity (Task 5's
// one real design decision, already made by the plan): id =
// "${kind}:${slug}:${locale}", e.g. "product_notes:kubki:pl",
// "page:home:en". Each (document, locale) pair is its own Resource.
// ---------------------------------------------------------------------------

export function encodeContentResourceId(kind: CmsDocumentKind, slug: string, locale: CmsLocale): string {
  return `${kind}:${slug}:${locale}`;
}

export type ContentResourceIdParts = { kind: CmsDocumentKind; slug: string; locale: CmsLocale };

/**
 * Parses a "${kind}:${slug}:${locale}" resource id. Returns null (never
 * throws) for anything malformed OR well-formed but not a real, editable
 * document per content.ts's EDITABLE_DOCUMENTS allowlist — e.g.
 * "page:studio:pl" is a real CmsDocumentKind/slug pair in the wider CMS
 * schema, but content.ts does not expose it via the admin functions this
 * CmsApi wraps, so it is not a valid content resource id here. Handlers
 * treat a null result as 404 NOT_FOUND, not 422 — an unknown resource id is
 * indistinguishable from "does not exist" at this API's boundary (same
 * posture as collections-get.ts's loadCollectionResponse returning null).
 */
export function decodeContentResourceId(id: string): ContentResourceIdParts | null {
  const parts = id.split(':');
  if (parts.length !== 3) return null;
  const [kind, slug, locale] = parts;
  if (!editableDocument(kind, slug)) return null;
  if (!(CMS_LOCALES as readonly string[]).includes(locale)) return null;
  return { kind: kind as CmsDocumentKind, slug, locale: locale as CmsLocale };
}

// ---------------------------------------------------------------------------
// Payload flattening — verified against cms/types.ts's CmsPayload variants.
// Every document this CmsApi exposes is exactly one of these three shapes
// (content.ts's EDITABLE_DOCUMENTS only ever contains product_notes
// documents, page:print-pdp, or page:home — see content.ts). Fields always
// carry locale: 'none'/sourceLocale: 'none': the Resource itself is already
// locale-scoped (one Resource per locale, per the id scheme above), so
// there is no further per-field locale subdivision the way collections'
// fields have (one Resource covering all 4 locales at once).
// ---------------------------------------------------------------------------

function isPrintPdp(doc: ContentDocumentRef): boolean {
  return doc.kind === 'page' && doc.slug === PRINT_PDP_SLUG;
}

function isHomePage(doc: ContentDocumentRef): boolean {
  return doc.kind === 'page' && doc.slug === HOME_PAGE_SLUG;
}

function textField(key: string, label: string, value: string): Field {
  return { key, label, type: 'text', value, locale: 'none', sourceLocale: 'none' };
}

/**
 * content.ts's payload (for one document + locale) → the Field[] the
 * generic Resource contract expects. `items` is content.ts's own
 * contentItems(slug) output — the live catalogue ids/labels a product_notes
 * document's `notes` record is keyed by.
 */
export function flattenContentPayload(doc: ContentDocumentRef, payload: CmsPayload, items: ContentItem[]): Field[] {
  if (doc.kind === 'product_notes') {
    const notes = (payload as ProductNotesPayload).notes ?? {};
    return items.map((item) => textField(item.id, item.label, notes[item.id] ?? ''));
  }
  if (isPrintPdp(doc)) {
    const p = payload as PrintPdpPayload;
    return [
      textField('artist.name', 'Artysta — imię i nazwisko', p.artist?.name ?? ''),
      textField('artist.bio', 'Artysta — biografia', p.artist?.bio ?? ''),
      textField('accordions.productDetails', 'Sekcja: Szczegóły produktu', p.accordions?.productDetails ?? ''),
      textField('accordions.framing', 'Sekcja: Oprawa i wykończenie', p.accordions?.framing ?? ''),
      textField('accordions.shipping', 'Sekcja: Wysyłka', p.accordions?.shipping ?? ''),
    ];
  }
  if (isHomePage(doc)) {
    const p = payload as HomePagePayload;
    // media.desktop/media.mobile (HeroMediaSlot, R2 asset references)
    // deliberately excluded — no Field.type fits them today (Task 5 brief).
    // Kept editable only via the legacy /admin/content editor.
    return [
      textField('heroLine1', 'Hero — wiersz 1', p.heroLine1 ?? ''),
      textField('heroLine2', 'Hero — wiersz 2', p.heroLine2 ?? ''),
      textField('heroTagline', 'Hero — tagline', p.heroTagline ?? ''),
      textField('ctaLabel', 'Przycisk CTA — etykieta', p.ctaLabel ?? ''),
      textField('heroAlt', 'Hero — tekst alternatywny (alt)', p.heroAlt ?? ''),
    ];
  }
  throw new Error(`unsupported_content_document: ${doc.kind}:${doc.slug}`);
}

/**
 * The inverse of flattenContentPayload: submitted Field[] → the raw payload
 * object to hand to content.ts's saveDraft (which validates it itself via
 * validateCmsPayload — this function does not validate, it only reshapes).
 *
 * `currentPayload` (the document/locale's existing payload, when known) is
 * required to correctly preserve `home`'s `media` slot: media is excluded
 * from this API's Field surface entirely, so without carrying the existing
 * value forward, saving any text field via /v1/content would silently wipe
 * out hero media set through the legacy editor. Same "protect a field the
 * client never sees" precedent as collections-save.ts's withProtectedKind.
 */
export function unflattenContentFields(doc: ContentDocumentRef, fields: Field[], currentPayload?: CmsPayload): unknown {
  const get = (key: string): string => fields.find((f) => f.key === key)?.value ?? '';

  if (doc.kind === 'product_notes') {
    return { notes: Object.fromEntries(fields.map((f) => [f.key, f.value])) };
  }
  if (isPrintPdp(doc)) {
    return {
      artist: { name: get('artist.name'), bio: get('artist.bio') },
      accordions: {
        productDetails: get('accordions.productDetails'),
        framing: get('accordions.framing'),
        shipping: get('accordions.shipping'),
      },
    };
  }
  if (isHomePage(doc)) {
    const media = (currentPayload as HomePagePayload | undefined)?.media ?? { desktop: null, mobile: null };
    return {
      heroLine1: get('heroLine1'),
      heroLine2: get('heroLine2'),
      heroTagline: get('heroTagline'),
      ctaLabel: get('ctaLabel'),
      heroAlt: get('heroAlt'),
      media,
    };
  }
  throw new Error(`unsupported_content_document: ${doc.kind}:${doc.slug}`);
}

// ---------------------------------------------------------------------------
// content.ts output → Resource
// ---------------------------------------------------------------------------

/**
 * Builds one locale's Resource from a ContentEditorState (content.ts's
 * getContentEditorState output) — pure, no I/O. `revision` is the highest
 * version number that exists for this locale (draft or published);
 * `publishedRevision` is that locale's own published version, independent
 * of `revision` — each locale has its own version-number sequence (Task 5
 * brief's key structural fact), unlike collections' single revision counter.
 */
export function toContentResource(state: ContentEditorState, locale: CmsLocale, localeState: LocaleEditorState): ContentResponse {
  return {
    id: encodeContentResourceId(state.kind, state.slug, locale),
    kind: 'content',
    name: state.label,
    revision: localeState.versions[0]?.version ?? 0,
    publishedRevision: localeState.published?.version ?? null,
    fields: flattenContentPayload({ kind: state.kind, slug: state.slug }, localeState.payload, state.items),
  };
}

// ---------------------------------------------------------------------------
// I/O wrappers over content.ts (unmodified) — thin glue only.
// ---------------------------------------------------------------------------

export type ContentResourceState = { resource: ContentResponse; payload: CmsPayload };

/**
 * Loads one document+locale, returning both the mapped Resource (for
 * revision-conflict checks / GET responses) and the raw current payload
 * (needed by unflattenContentFields's home media-preservation merge).
 * Returns null only when content.ts does not recognize kind/slug as an
 * editable document at all — a real document with zero saved drafts yet
 * still returns a (revision: 0) state, not null.
 *
 * `supabase` is required (not defaulted) and must be the CmsApi handler
 * context's `ctx.supabase` (built by `deps.makeSupabase(env)` — see
 * request-handler.ts). content.ts's own default client
 * (`adminSupabase()`/`getCloudflareContext()`) only works inside a request
 * wrapped by `runWithCloudflareRequestContext`; `CmsApi` is a
 * `WorkerEntrypoint` invoked over a service binding and is never wrapped
 * that way, so relying on content.ts's default here would throw in
 * production. Passing the client explicitly, rather than making it
 * optional, prevents that failure mode from silently reappearing.
 */
export async function loadContentResourceState(kind: CmsDocumentKind, slug: string, locale: CmsLocale, supabase: SupabaseClient): Promise<ContentResourceState | null> {
  const state = await getContentEditorState(kind, slug, undefined, supabase);
  if (!state) return null;
  const localeState = state.locales[locale];
  return { resource: toContentResource(state, locale, localeState), payload: localeState.payload };
}

export async function loadContentResource(kind: CmsDocumentKind, slug: string, locale: CmsLocale, supabase: SupabaseClient): Promise<ContentResponse | null> {
  const state = await loadContentResourceState(kind, slug, locale, supabase);
  return state?.resource ?? null;
}

/**
 * Every editable document x every locale — up to EDITABLE_DOCUMENTS.length x
 * 4 Resources (currently 12 x 4 = 48; see content.ts's EDITABLE_DOCUMENTS
 * for the exact current count — 9 category product_notes + fine-art-prints
 * + print-pdp + home). One getContentEditorState call per document (not
 * per document x locale — each call already returns all 4 locales' state at
 * once); mirrors collections-mapping.ts's per-id N+1 query pattern at a
 * comparable, small, admin-panel scale.
 */
export async function loadAllContentResources(supabase: SupabaseClient): Promise<ContentResponse[]> {
  const states = await Promise.all(EDITABLE_DOCUMENTS.map((doc) => getContentEditorState(doc.kind, doc.slug, undefined, supabase)));
  const items: ContentResponse[] = [];
  for (const state of states) {
    if (!state) continue; // defensive: content.ts's own allowlist disagreeing with itself should not be possible
    for (const locale of CMS_LOCALES) {
      items.push(toContentResource(state, locale, state.locales[locale]));
    }
  }
  return items;
}
