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
