// Focused unit tests for the race-safe `ensureDocument` fix inside
// `saveDraft` — the home-hero editor's 4-locale media fan-out fires 4
// concurrent saveDraft calls against the same fresh (kind, slug), so only
// one insert can win the `unique (kind, slug)` constraint. `adminSupabase`
// is not dependency-injected in this module, so it's mocked at the module
// boundary (`@/lib/admin/clients`) rather than passed in.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HOME_PAGE_SLUG } from '@/lib/cms/types';

const VALID_HOME_PAYLOAD = {
  heroLine1: 'a',
  heroLine2: 'b',
  heroTagline: '',
  ctaLabel: 'c',
  heroAlt: '',
  media: { desktop: null, mobile: null },
};

type Row = { id: string; kind: string; slug: string; status: string; updated_at: string; published_at: string | null; cms_document_versions?: unknown[] };

function makeFakeSupabase(opts: {
  documentReads: Array<{ data: Row | null; error: unknown }>;
  upsertResult: { data: { id: string } | null; error: unknown };
}) {
  let readIndex = 0;
  const versionInsert = vi.fn((row: Record<string, unknown>) => ({
    select: () => ({
      single: async () => ({
        data: { ...row, id: 'version-1', created_at: 'now' },
        error: null,
      }),
    }),
  }));

  const cmsDocumentsTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => {
            const i = Math.min(readIndex, opts.documentReads.length - 1);
            readIndex += 1;
            return opts.documentReads[i];
          },
        }),
      }),
    }),
    upsert: () => ({
      select: () => ({
        maybeSingle: async () => opts.upsertResult,
      }),
    }),
    update: () => ({
      eq: async () => ({ data: null, error: null }),
    }),
  };

  const cmsDocumentVersionsTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          order: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
        }),
      }),
    }),
    insert: versionInsert,
  };

  const cmsAuditLogTable = {
    insert: async () => ({ data: null, error: null }),
  };

  const from = vi.fn((table: string) => {
    if (table === 'cms_documents') return cmsDocumentsTable;
    if (table === 'cms_document_versions') return cmsDocumentVersionsTable;
    if (table === 'cms_audit_log') return cmsAuditLogTable;
    throw new Error(`unexpected table in test mock: ${table}`);
  });

  return { from, versionInsert, readCount: () => readIndex };
}

const mocks = vi.hoisted(() => ({ adminSupabase: vi.fn() }));
vi.mock('./clients', () => ({ adminSupabase: mocks.adminSupabase }));

// Minimal fake Supabase client for getContentEditorState: a single
// cms_documents row with an embedded cms_document_versions array, matching
// getRawDocument's actual select shape.
function makeContentStateFakeSupabase(row: {
  id: string;
  kind: string;
  slug: string;
  status: string;
  updated_at: string;
  published_at: string | null;
  cms_document_versions: unknown[];
}) {
  return {
    from: (table: string) => {
      if (table !== 'cms_documents') throw new Error(`unexpected table in test mock: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: row, error: null }),
            }),
          }),
        }),
      };
    },
  };
}

describe('contentItems threads definitions through print naming', () => {
  it('uses definitions to resolve fine-art-print names (discriminating fixture)', async () => {
    // The static PRINT_COLLECTION_DEFINITIONS default maps fap005 to 'Horizons 01'.
    // This test mocks definitions with 'CmsOnly' for fap005, so asserting on the label
    // proves that the definitions parameter was actually threaded through to
    // printDisplayName, not silently dropped in favor of the static fallback.
    const discriminatingDefs = [
      { slug: 'cms-only', name: 'CmsOnly', designIds: ['fap005'], prints: [] },
    ];
    const { contentItems } = await import('./content');
    const items = contentItems('fine-art-prints', discriminatingDefs);
    const fap005Item = items.find((item) => item.id === 'fap005');
    expect(fap005Item).toBeDefined();
    expect(fap005Item?.label).toBe('CmsOnly 01');
    expect(fap005Item?.label).not.toContain('Horizons');
  });
});

describe('saveDraft -> ensureDocument race safety', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the document via upsert when none exists yet (normal insert wins)', async () => {
    const fake = makeFakeSupabase({
      documentReads: [{ data: null, error: null }],
      upsertResult: { data: { id: 'doc-new' }, error: null },
    });
    mocks.adminSupabase.mockReturnValue(fake);

    const { saveDraft } = await import('./content');
    const result = await saveDraft({ kind: 'page', slug: HOME_PAGE_SLUG, locale: 'pl', payload: VALID_HOME_PAYLOAD });

    expect(result.id).toBe('version-1');
    expect(fake.versionInsert).toHaveBeenCalledWith(expect.objectContaining({ document_id: 'doc-new' }));
    // Only the fast-path read — the upsert won, so no re-read was needed.
    expect(fake.readCount()).toBe(1);
  });

  it('re-reads and uses the winning row when the insert loses the unique(kind,slug) race', async () => {
    const existingRow: Row = {
      id: 'doc-existing',
      kind: 'page',
      slug: HOME_PAGE_SLUG,
      status: 'draft',
      updated_at: 'now',
      published_at: null,
      cms_document_versions: [],
    };
    const fake = makeFakeSupabase({
      // 1st read (fast path): nothing yet. 2nd read (after losing the race): the winner's row.
      documentReads: [
        { data: null, error: null },
        { data: existingRow, error: null },
      ],
      // ignoreDuplicates hit the conflict -> DO NOTHING -> no row returned.
      upsertResult: { data: null, error: null },
    });
    mocks.adminSupabase.mockReturnValue(fake);

    const { saveDraft } = await import('./content');
    const result = await saveDraft({ kind: 'page', slug: HOME_PAGE_SLUG, locale: 'pl', payload: VALID_HOME_PAYLOAD });

    expect(result.id).toBe('version-1');
    expect(fake.versionInsert).toHaveBeenCalledWith(expect.objectContaining({ document_id: 'doc-existing' }));
    expect(fake.readCount()).toBe(2);
  });

  it('throws when the document is still missing after losing the race (should not happen, but must not hang)', async () => {
    const fake = makeFakeSupabase({
      documentReads: [
        { data: null, error: null },
        { data: null, error: null },
      ],
      upsertResult: { data: null, error: null },
    });
    mocks.adminSupabase.mockReturnValue(fake);

    const { saveDraft } = await import('./content');
    await expect(
      saveDraft({ kind: 'page', slug: HOME_PAGE_SLUG, locale: 'pl', payload: VALID_HOME_PAYLOAD }),
    ).rejects.toThrow('document_not_found');
  });
});

// Reproduces a real production bug (confirmed live via Supabase against
// document db699e12-2604-4b82-ac61-a1891ce6d950, locale 'pl'): after
// publish_cms_version demotes a superseded published row back to
// status='draft' (supabase/migrations/20260709120000_cms_publish_rpc.sql),
// an intervening draft that was itself never published — but whose version
// number sits between the demoted row and the new latest published row —
// can outrank the true latest content. localeState()'s `latestDraft` picks
// the highest-versioned row with status==='draft', so it stops at that
// stale intervening draft instead of falling through to `published` (the
// actual most recent write). The editor then reloads stale field values,
// and the next save/publish silently discards the real latest content.
describe('localeState (via getContentEditorState) — stale intervening draft regression', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the true latest version (the published one), not a lower-numbered stale draft left over from an earlier publish/demote', async () => {
    const v1Published = {
      id: 'v1', document_id: 'doc-1', locale: 'pl', version: 1, status: 'draft', // demoted back to draft when v3 published
      payload: { heroLine1: 'a', heroLine2: 'STALE — should never be shown', heroTagline: 'stale', ctaLabel: 'c', heroAlt: '', media: { desktop: null, mobile: null } },
      created_by: null, created_at: 't1',
    };
    const v2NeverPublished = {
      id: 'v2', document_id: 'doc-1', locale: 'pl', version: 2, status: 'draft', // saved after v1 was published, itself never published
      payload: { heroLine1: 'a', heroLine2: 'ALSO STALE — never published, must not win', heroTagline: 'also stale', ctaLabel: 'c', heroAlt: '', media: { desktop: null, mobile: null } },
      created_by: null, created_at: 't2',
    };
    const v3CurrentlyPublished = {
      id: 'v3', document_id: 'doc-1', locale: 'pl', version: 3, status: 'published', // the true latest write
      payload: { heroLine1: 'a', heroLine2: 'CURRENT — this is what must be shown', heroTagline: 'current', ctaLabel: 'c', heroAlt: '', media: { desktop: null, mobile: null } },
      created_by: null, created_at: 't3',
    };
    const fake = makeContentStateFakeSupabase({
      id: 'doc-1',
      kind: 'page',
      slug: HOME_PAGE_SLUG,
      status: 'published',
      updated_at: 'now',
      published_at: 'now',
      cms_document_versions: [v1Published, v2NeverPublished, v3CurrentlyPublished],
    });

    const { getContentEditorState } = await import('./content');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = await getContentEditorState('page', HOME_PAGE_SLUG, undefined, fake as any);

    expect(state?.locales.pl.payload).toEqual(v3CurrentlyPublished.payload);
    expect(state?.locales.pl.versions[0]?.version).toBe(3);
  });
});
