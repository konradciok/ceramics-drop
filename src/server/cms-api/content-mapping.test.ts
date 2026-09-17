import { describe, expect, it, vi } from 'vitest';
import {
  encodeContentResourceId,
  decodeContentResourceId,
  flattenContentPayload,
  unflattenContentFields,
  toContentResource,
  loadContentResourceState,
  loadContentResource,
  loadAllContentResources,
} from './content-mapping';
import type { Field } from './types';
import type { ContentEditorState, ContentItem } from '@/lib/admin/content';

vi.mock('@/lib/admin/content', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin/content')>('@/lib/admin/content');
  return {
    ...actual,
    getContentEditorState: vi.fn(),
  };
});

import { getContentEditorState } from '@/lib/admin/content';

// ---------------------------------------------------------------------------
// encode/decode
// ---------------------------------------------------------------------------

describe('encodeContentResourceId', () => {
  it('joins kind, slug, locale with colons', () => {
    expect(encodeContentResourceId('product_notes', 'kubki', 'pl')).toBe('product_notes:kubki:pl');
    expect(encodeContentResourceId('page', 'home', 'en')).toBe('page:home:en');
  });
});

describe('decodeContentResourceId', () => {
  it('parses a well-formed content resource id for a real editable document', () => {
    expect(decodeContentResourceId('product_notes:kubki:pl')).toEqual({ kind: 'product_notes', slug: 'kubki', locale: 'pl' });
    expect(decodeContentResourceId('page:home:en')).toEqual({ kind: 'page', slug: 'home', locale: 'en' });
    expect(decodeContentResourceId('page:print-pdp:de')).toEqual({ kind: 'page', slug: 'print-pdp', locale: 'de' });
    expect(decodeContentResourceId('product_notes:fine-art-prints:es')).toEqual({
      kind: 'product_notes',
      slug: 'fine-art-prints',
      locale: 'es',
    });
  });

  it('returns null for an id with the wrong number of segments', () => {
    expect(decodeContentResourceId('product_notes:kubki')).toBeNull();
    expect(decodeContentResourceId('product_notes:kubki:pl:extra')).toBeNull();
    expect(decodeContentResourceId('no-colons-here')).toBeNull();
  });

  it('returns null for a kind/slug pair that is not in the EDITABLE_DOCUMENTS allowlist', () => {
    expect(decodeContentResourceId('product_notes:not-a-category:pl')).toBeNull();
    expect(decodeContentResourceId('page:studio:pl')).toBeNull(); // real CmsDocumentKind, but not editable via CmsApi
    expect(decodeContentResourceId('collection:kubki:pl')).toBeNull();
  });

  it('returns null for an unknown locale', () => {
    expect(decodeContentResourceId('product_notes:kubki:fr')).toBeNull();
  });

  it('round-trips through encode/decode for every real editable document x locale', () => {
    // kubki (product_notes), print-pdp and home cover all three payload shapes.
    for (const [kind, slug] of [
      ['product_notes', 'kubki'],
      ['page', 'print-pdp'],
      ['page', 'home'],
    ] as const) {
      for (const locale of ['pl', 'en', 'es', 'de'] as const) {
        const id = encodeContentResourceId(kind, slug, locale);
        expect(decodeContentResourceId(id)).toEqual({ kind, slug, locale });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// flatten / unflatten — product_notes
// ---------------------------------------------------------------------------

const noteItems: ContentItem[] = [
  { id: 'kubki-01', label: 'Kubki Nº 01', image: '/img/1.jpg' },
  { id: 'kubki-02', label: 'Kubki Nº 02', image: '/img/2.jpg' },
];

describe('flattenContentPayload — product_notes', () => {
  it('produces one text field per catalogue item, in catalogue order, with the item label', () => {
    const fields = flattenContentPayload(
      { kind: 'product_notes', slug: 'kubki' },
      { notes: { 'kubki-01': 'Ręcznie toczony.', 'kubki-02': 'Matowa glazura.' } },
      noteItems,
    );
    expect(fields).toEqual([
      { key: 'kubki-01', label: 'Kubki Nº 01', type: 'text', value: 'Ręcznie toczony.', locale: 'none', sourceLocale: 'none' },
      { key: 'kubki-02', label: 'Kubki Nº 02', type: 'text', value: 'Matowa glazura.', locale: 'none', sourceLocale: 'none' },
    ]);
  });

  it('defaults a missing note to an empty string rather than dropping the field', () => {
    const fields = flattenContentPayload({ kind: 'product_notes', slug: 'kubki' }, { notes: { 'kubki-01': 'Only this one.' } }, noteItems);
    expect(fields.find((f) => f.key === 'kubki-02')?.value).toBe('');
  });
});

describe('unflattenContentFields — product_notes', () => {
  it('rebuilds {notes: Record<id,string>} from the submitted fields', () => {
    const fields: Field[] = [
      { key: 'kubki-01', label: 'Kubki Nº 01', type: 'text', value: 'A', locale: 'none', sourceLocale: 'none' },
      { key: 'kubki-02', label: 'Kubki Nº 02', type: 'text', value: 'B', locale: 'none', sourceLocale: 'none' },
    ];
    expect(unflattenContentFields({ kind: 'product_notes', slug: 'kubki' }, fields)).toEqual({
      notes: { 'kubki-01': 'A', 'kubki-02': 'B' },
    });
  });
});

// ---------------------------------------------------------------------------
// flatten / unflatten — print-pdp
// ---------------------------------------------------------------------------

describe('flattenContentPayload — print-pdp', () => {
  it('produces the 5 dotted-key fields from the nested payload', () => {
    const fields = flattenContentPayload(
      { kind: 'page', slug: 'print-pdp' },
      {
        artist: { name: 'Anna Ciok', bio: 'Ceramiczka i grafik.' },
        accordions: { productDetails: 'Papier archiwalny.', framing: 'Rama dębowa.', shipping: 'Wysyłka w tubie.' },
      },
      [],
    );
    expect(fields.map((f) => f.key)).toEqual(['artist.name', 'artist.bio', 'accordions.productDetails', 'accordions.framing', 'accordions.shipping']);
    expect(fields.find((f) => f.key === 'artist.name')?.value).toBe('Anna Ciok');
    expect(fields.find((f) => f.key === 'accordions.shipping')?.value).toBe('Wysyłka w tubie.');
    for (const f of fields) {
      expect(f.locale).toBe('none');
      expect(f.sourceLocale).toBe('none');
      expect(f.type).toBe('text');
    }
  });

  it('tolerates empty section values (empty = intentionally disabled)', () => {
    const fields = flattenContentPayload(
      { kind: 'page', slug: 'print-pdp' },
      { artist: { name: '', bio: '' }, accordions: { productDetails: '', framing: '', shipping: '' } },
      [],
    );
    expect(fields.every((f) => f.value === '')).toBe(true);
  });
});

describe('unflattenContentFields — print-pdp', () => {
  it('rebuilds the nested {artist, accordions} shape from dotted-key fields', () => {
    const fields: Field[] = [
      { key: 'artist.name', label: 'x', type: 'text', value: 'Anna Ciok', locale: 'none', sourceLocale: 'none' },
      { key: 'artist.bio', label: 'x', type: 'text', value: 'Bio.', locale: 'none', sourceLocale: 'none' },
      { key: 'accordions.productDetails', label: 'x', type: 'text', value: 'PD', locale: 'none', sourceLocale: 'none' },
      { key: 'accordions.framing', label: 'x', type: 'text', value: 'FR', locale: 'none', sourceLocale: 'none' },
      { key: 'accordions.shipping', label: 'x', type: 'text', value: 'SH', locale: 'none', sourceLocale: 'none' },
    ];
    expect(unflattenContentFields({ kind: 'page', slug: 'print-pdp' }, fields)).toEqual({
      artist: { name: 'Anna Ciok', bio: 'Bio.' },
      accordions: { productDetails: 'PD', framing: 'FR', shipping: 'SH' },
    });
  });

  it('defaults a missing dotted key to an empty string', () => {
    const fields: Field[] = [{ key: 'artist.name', label: 'x', type: 'text', value: 'Anna Ciok', locale: 'none', sourceLocale: 'none' }];
    expect(unflattenContentFields({ kind: 'page', slug: 'print-pdp' }, fields)).toEqual({
      artist: { name: 'Anna Ciok', bio: '' },
      accordions: { productDetails: '', framing: '', shipping: '' },
    });
  });
});

// ---------------------------------------------------------------------------
// flatten / unflatten — home (media excluded from scope)
// ---------------------------------------------------------------------------

describe('flattenContentPayload — home', () => {
  it('produces the 5 flat text fields and never surfaces a media field', () => {
    const fields = flattenContentPayload(
      { kind: 'page', slug: 'home' },
      {
        heroLine1: 'Linia 1',
        heroLine2: 'Linia 2',
        heroTagline: 'Tag',
        ctaLabel: 'Zobacz',
        heroAlt: 'Alt',
        media: { desktop: null, mobile: null },
      },
      [],
    );
    expect(fields.map((f) => f.key)).toEqual(['heroLine1', 'heroLine2', 'heroTagline', 'ctaLabel', 'heroAlt']);
    expect(fields.some((f) => f.key.includes('media'))).toBe(false);
  });
});

describe('unflattenContentFields — home', () => {
  it('preserves the current payload.media untouched (hero media is out of v1 scope)', () => {
    const fields: Field[] = [
      { key: 'heroLine1', label: 'x', type: 'text', value: 'New line 1', locale: 'none', sourceLocale: 'none' },
      { key: 'heroLine2', label: 'x', type: 'text', value: 'L2', locale: 'none', sourceLocale: 'none' },
      { key: 'heroTagline', label: 'x', type: 'text', value: 'Tag', locale: 'none', sourceLocale: 'none' },
      { key: 'ctaLabel', label: 'x', type: 'text', value: 'CTA', locale: 'none', sourceLocale: 'none' },
      { key: 'heroAlt', label: 'x', type: 'text', value: 'Alt', locale: 'none', sourceLocale: 'none' },
    ];
    const currentPayload = {
      heroLine1: 'Old line 1',
      heroLine2: 'Old L2',
      heroTagline: 'Old tag',
      ctaLabel: 'Old CTA',
      heroAlt: 'Old alt',
      media: { desktop: { kind: 'image' as const, key: 'hero/desktop.jpg', width: 100, height: 200 }, mobile: null },
    };
    const result = unflattenContentFields({ kind: 'page', slug: 'home' }, fields, currentPayload) as { media: unknown; heroLine1: string };
    expect(result.media).toEqual(currentPayload.media);
    expect(result.heroLine1).toBe('New line 1');
  });

  it('falls back to {desktop: null, mobile: null} media when there is no current payload (brand new document)', () => {
    const fields: Field[] = [
      { key: 'heroLine1', label: 'x', type: 'text', value: 'L1', locale: 'none', sourceLocale: 'none' },
      { key: 'heroLine2', label: 'x', type: 'text', value: 'L2', locale: 'none', sourceLocale: 'none' },
      { key: 'heroTagline', label: 'x', type: 'text', value: '', locale: 'none', sourceLocale: 'none' },
      { key: 'ctaLabel', label: 'x', type: 'text', value: 'CTA', locale: 'none', sourceLocale: 'none' },
      { key: 'heroAlt', label: 'x', type: 'text', value: '', locale: 'none', sourceLocale: 'none' },
    ];
    const result = unflattenContentFields({ kind: 'page', slug: 'home' }, fields) as { media: unknown };
    expect(result.media).toEqual({ desktop: null, mobile: null });
  });
});

describe('flatten/unflatten round-trip', () => {
  it('unflatten(flatten(payload)) reproduces the same payload for print-pdp', () => {
    const payload = { artist: { name: 'A', bio: 'B' }, accordions: { productDetails: 'C', framing: 'D', shipping: 'E' } };
    const fields = flattenContentPayload({ kind: 'page', slug: 'print-pdp' }, payload, []);
    expect(unflattenContentFields({ kind: 'page', slug: 'print-pdp' }, fields)).toEqual(payload);
  });

  it('unflatten(flatten(payload)) reproduces the same notes for product_notes', () => {
    const payload = { notes: { 'kubki-01': 'A', 'kubki-02': 'B' } };
    const fields = flattenContentPayload({ kind: 'product_notes', slug: 'kubki' }, payload, noteItems);
    expect(unflattenContentFields({ kind: 'product_notes', slug: 'kubki' }, fields)).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// toContentResource
// ---------------------------------------------------------------------------

function makeState(overrides?: Partial<ContentEditorState>): ContentEditorState {
  return {
    kind: 'product_notes',
    slug: 'kubki',
    label: 'kubki',
    publicPath: '/kubki',
    documentId: 'doc_1',
    items: noteItems,
    locales: {
      pl: { locale: 'pl', payload: { notes: { 'kubki-01': 'A', 'kubki-02': 'B' } }, latestDraft: null, published: null, versions: [] },
      en: { locale: 'en', payload: { notes: {} }, latestDraft: null, published: null, versions: [] },
      es: { locale: 'es', payload: { notes: {} }, latestDraft: null, published: null, versions: [] },
      de: { locale: 'de', payload: { notes: {} }, latestDraft: null, published: null, versions: [] },
    },
    ...overrides,
  };
}

describe('toContentResource', () => {
  it('encodes the id as kind:slug:locale and uses the document label as name', () => {
    const state = makeState();
    const resource = toContentResource(state, 'pl', state.locales.pl);
    expect(resource.id).toBe('product_notes:kubki:pl');
    expect(resource.kind).toBe('content');
    expect(resource.name).toBe('kubki');
  });

  it('sets revision to the highest version number for this locale (draft or published)', () => {
    const state = makeState({
      locales: {
        ...makeState().locales,
        pl: {
          locale: 'pl',
          payload: { notes: {} },
          latestDraft: { id: 'v3', document_id: 'doc_1', locale: 'pl', version: 3, status: 'draft', payload: { notes: {} }, created_by: null, created_at: '' },
          published: { id: 'v2', document_id: 'doc_1', locale: 'pl', version: 2, status: 'published', payload: { notes: {} }, created_by: null, created_at: '' },
          versions: [
            { id: 'v3', document_id: 'doc_1', locale: 'pl', version: 3, status: 'draft', payload: { notes: {} }, created_by: null, created_at: '' },
            { id: 'v2', document_id: 'doc_1', locale: 'pl', version: 2, status: 'published', payload: { notes: {} }, created_by: null, created_at: '' },
          ],
        },
      },
    });
    const resource = toContentResource(state, 'pl', state.locales.pl);
    expect(resource.revision).toBe(3);
    expect(resource.publishedRevision).toBe(2);
  });

  it('reports revision 0 and publishedRevision null for a locale with no versions yet', () => {
    const state = makeState();
    const resource = toContentResource(state, 'en', state.locales.en);
    expect(resource.revision).toBe(0);
    expect(resource.publishedRevision).toBeNull();
  });

  it('flattens the locale payload into fields using this document kind/slug', () => {
    const state = makeState();
    const resource = toContentResource(state, 'pl', state.locales.pl);
    expect(resource.fields).toEqual([
      { key: 'kubki-01', label: 'Kubki Nº 01', type: 'text', value: 'A', locale: 'none', sourceLocale: 'none' },
      { key: 'kubki-02', label: 'Kubki Nº 02', type: 'text', value: 'B', locale: 'none', sourceLocale: 'none' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// I/O wrappers over content.ts (mocked)
// ---------------------------------------------------------------------------

describe('loadContentResourceState', () => {
  it('returns null when content.ts reports no such editable document', async () => {
    vi.mocked(getContentEditorState).mockResolvedValue(null);
    const result = await loadContentResourceState('product_notes', 'unknown', 'pl');
    expect(result).toBeNull();
  });

  it('returns the mapped resource and raw payload for a real document/locale', async () => {
    vi.mocked(getContentEditorState).mockResolvedValue(makeState());
    const result = await loadContentResourceState('product_notes', 'kubki', 'pl');
    expect(result?.resource.id).toBe('product_notes:kubki:pl');
    expect(result?.payload).toEqual({ notes: { 'kubki-01': 'A', 'kubki-02': 'B' } });
  });
});

describe('loadContentResource', () => {
  it('returns just the mapped resource', async () => {
    vi.mocked(getContentEditorState).mockResolvedValue(makeState());
    const result = await loadContentResource('product_notes', 'kubki', 'en');
    expect(result?.id).toBe('product_notes:kubki:en');
  });

  it('returns null when the underlying state is null', async () => {
    vi.mocked(getContentEditorState).mockResolvedValue(null);
    expect(await loadContentResource('product_notes', 'kubki', 'pl')).toBeNull();
  });
});

describe('loadAllContentResources', () => {
  it('returns 4 resources (one per locale) for every EDITABLE_DOCUMENTS entry', async () => {
    vi.mocked(getContentEditorState).mockImplementation(async (kind, slug) => makeState({ kind, slug, label: slug }));
    const items = await loadAllContentResources();
    // 9 categories + fine-art-prints (product_notes) + print-pdp + home = 12 documents x 4 locales.
    expect(items).toHaveLength(48);
    expect(items.filter((r) => r.kind === 'content')).toHaveLength(48);
    const ids = new Set(items.map((r) => r.id));
    expect(ids.size).toBe(48); // every id unique
    expect(ids.has('product_notes:kubki:pl')).toBe(true);
    expect(ids.has('page:home:en')).toBe(true);
    expect(ids.has('page:print-pdp:de')).toBe(true);
  });

  it('skips a document if content.ts unexpectedly reports it as unknown', async () => {
    vi.mocked(getContentEditorState).mockImplementation(async (kind, slug) =>
      slug === 'kubki' ? null : makeState({ kind, slug, label: slug }),
    );
    const items = await loadAllContentResources();
    expect(items.some((r) => r.id.startsWith('product_notes:kubki:'))).toBe(false);
    expect(items).toHaveLength(44); // 11 remaining documents x 4 locales
  });
});
