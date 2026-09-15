import { describe, expect, it, vi, beforeEach } from 'vitest';
import { collectionsCreateRoute } from './collections-create';
import { collectionsSaveRoute } from './collections-save';
import { collectionsPublicationPostRoute } from './collections-publication';
import { collectionsRestorePostRoute } from './collections-restore';
import type { HandlerContext } from '../router';
import * as idempotency from '../idempotency';
import type { Field } from '../types';

// End-to-end: create -> save -> publish -> restore chained through the real
// route handlers and the real (unmocked) collections-mapping.ts, against one
// small stateful, in-memory Supabase stub shared across all four calls. This
// is deliberately NOT four isolated per-handler tests with hand-typed
// response fixtures (those already exist in collections-create.test.ts /
// collections-save.test.ts / collections-publication.test.ts /
// collections-restore.test.ts) — the point here is that revision numbers and
// publishedRevision are *produced* by the sequence itself, the same way the
// real create_collection_with_draft/save_collection_draft/
// publish_collection_revision/restore_collection_draft RPCs
// (supabase/migrations/20260915120000_cms_api_collections.sql) would produce
// them, so a bug in how one step's output feeds the next step's input would
// actually be caught.
//
// Only idempotency.ts is mocked (module-level, same `vi.mock` pattern as
// every other handlers/*.test.ts file in this plan) — its own leased-CAS
// behavior against cms_api_idempotency_keys is covered by idempotency.test.ts
// and isn't what this test is exercising.
vi.mock('../idempotency');

type CollectionRow = { id: string; published_revision: number | null };
type DraftPayload = { name: string; fields: Field[] };
type DraftRow = { collection_id: string; revision: number; payload: DraftPayload };

type FakeState = {
  collections: Map<string, CollectionRow>;
  drafts: DraftRow[];
  validProductIds: Set<string>;
};

function createFakeState(validProductIds: string[]): FakeState {
  return { collections: new Map(), drafts: [], validProductIds: new Set(validProductIds) };
}

function maxRevision(state: FakeState, collectionId: string): number {
  return state.drafts
    .filter((d) => d.collection_id === collectionId)
    .reduce((max, d) => Math.max(max, d.revision), 0);
}

function rpcError(message: string, details?: string) {
  return { error: { message, details } };
}

// Mirrors the four RPCs' documented behavior (Global Constraints 7-11, 19;
// the migration itself) closely enough to drive a real revision sequence,
// without re-implementing Postgres — this is a JS stand-in for the RPC
// layer, not a claim that it's tested here (that's the pgTAP suite's job).
function runRpc(state: FakeState, fn: string, args: Record<string, unknown>): { error: { message: string; details?: string } | null } {
  switch (fn) {
    case 'create_collection_with_draft': {
      const id = args.p_id as string;
      state.collections.set(id, { id, published_revision: null });
      state.drafts.push({ collection_id: id, revision: 1, payload: args.p_payload as DraftPayload });
      return { error: null };
    }
    case 'save_collection_draft': {
      const id = args.p_collection_id as string;
      if (!state.collections.has(id)) return rpcError('collection_not_found');
      const current = maxRevision(state, id);
      const expected = args.p_expected_revision as number;
      if (current !== expected) return rpcError('revision_conflict', `currentRevision=${current}`);
      state.drafts.push({ collection_id: id, revision: current + 1, payload: args.p_payload as DraftPayload });
      return { error: null };
    }
    case 'publish_collection_revision': {
      const id = args.p_collection_id as string;
      if (!state.collections.has(id)) return rpcError('collection_not_found');
      const current = maxRevision(state, id);
      const expected = args.p_expected_revision as number;
      if (current !== expected) return rpcError('revision_conflict', `currentRevision=${current}`);
      if (expected === 0) return rpcError('draft_required');

      const draft = state.drafts.find((d) => d.collection_id === id && d.revision === expected);
      if (!draft) return rpcError('collection_not_found');

      const plField = draft.payload.fields.find((f) => f.locale === 'pl');
      if (!plField || plField.value.trim() === '') return rpcError('missing_polish');

      const productsField = draft.payload.fields.find((f) => f.type === 'productIds');
      const invalidIds = (productsField?.value ?? '')
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0)
        .filter((token) => !state.validProductIds.has(token));
      if (invalidIds.length > 0) return rpcError('product_ref_invalid', `invalidIds=${invalidIds.join(',')}`);

      state.collections.set(id, { id, published_revision: expected });
      return { error: null };
    }
    case 'restore_collection_draft': {
      const id = args.p_collection_id as string;
      if (!state.collections.has(id)) return rpcError('collection_not_found');
      const current = maxRevision(state, id);
      const expected = args.p_expected_revision as number;
      if (current !== expected) return rpcError('revision_conflict', `currentRevision=${current}`);

      const source = args.p_source_revision as number;
      const sourceDraft = state.drafts.find((d) => d.collection_id === id && d.revision === source);
      if (!sourceDraft) return rpcError('source_revision_not_found');

      state.drafts.push({ collection_id: id, revision: current + 1, payload: sourceDraft.payload });
      return { error: null };
    }
    default:
      throw new Error(`collections-e2e.test.ts: unmocked rpc "${fn}"`);
  }
}

// Chainable, thenable query-builder stub covering exactly the
// select/in/order surface collections-mapping.ts's loadCollectionResponses
// uses. collections-mapping.ts itself is NOT mocked in this file — it runs
// for real against the rows below, so response assembly is genuinely
// exercised, not asserted-by-fixture.
function makeQueryBuilder(rows: unknown[]) {
  let result = rows;
  const builder = {
    in(column: string, values: string[]) {
      result = result.filter((row) => values.includes((row as Record<string, unknown>)[column] as string));
      return builder;
    },
    order(column: string, opts: { ascending: boolean }) {
      result = [...result].sort((a, b) => {
        const av = (a as Record<string, number>)[column];
        const bv = (b as Record<string, number>)[column];
        return opts.ascending ? av - bv : bv - av;
      });
      return builder;
    },
    then(resolve: (v: { data: unknown[]; error: null }) => void) {
      resolve({ data: result, error: null });
    },
  };
  return builder;
}

function makeFakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      return {
        select() {
          if (table === 'collections') return makeQueryBuilder([...state.collections.values()]);
          if (table === 'collection_drafts') return makeQueryBuilder([...state.drafts]);
          throw new Error(`collections-e2e.test.ts: unmocked table "${table}"`);
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      return Promise.resolve(runRpc(state, fn, args));
    },
  };
}

function ctxWith(supabase: ReturnType<typeof makeFakeSupabase>): HandlerContext {
  return { actorEmail: 'anna@studio.pl', requestId: 'req_e2e', supabase: supabase as never };
}

const VALID_PRODUCT_ID = 'prd_e2e_teapot';

const publishableFields: Field[] = [
  { key: 'description', label: 'Opis kolekcji', type: 'text', value: 'Nowy opis kolekcji', locale: 'pl', sourceLocale: 'pl' },
  { key: 'description', label: 'Opis kolekcji', type: 'text', value: 'New description', locale: 'en', sourceLocale: 'pl' },
  { key: 'products', label: 'Produkty i kolejność', type: 'productIds', value: VALID_PRODUCT_ID, locale: 'none', sourceLocale: 'none' },
];

describe('collections end-to-end: create -> save -> publish -> restore', () => {
  beforeEach(() => {
    vi.mocked(idempotency.claimIdempotencyKey).mockResolvedValue({ kind: 'run', leaseToken: 'lease-e2e' });
    vi.mocked(idempotency.completeIdempotencyKey).mockResolvedValue(undefined);
    vi.mocked(idempotency.releaseIdempotencyKey).mockResolvedValue(undefined);
  });

  it('chains all four operations against one consistent in-memory Supabase state, with revisions that genuinely accumulate', async () => {
    const state = createFakeState([VALID_PRODUCT_ID]);
    const supabase = makeFakeSupabase(state);
    const ctx = ctxWith(supabase);

    // 1. create — starts at revision 1, unpublished, seeded with the
    // handler's own default fields (a blank pl description among them).
    const createRes = await collectionsCreateRoute.handler(
      new Request('https://x.test/v1/collections', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'create-key' },
        body: JSON.stringify({ name: 'Spokojne formy' }),
      }),
      {} as CloudflareEnv,
      {},
      ctx,
    );
    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    expect(created).toMatchObject({ kind: 'collections', name: 'Spokojne formy', revision: 1, publishedRevision: null });
    expect(created.fields).toHaveLength(5);
    const collectionId = created.id as string;
    expect(collectionId).toMatch(/^col_[0-9a-f]{10}$/);

    // 2. save — bumps the draft to revision 2 with real, publishable content
    // (non-blank pl field + a productIds field pointing at a real product).
    const saveRes = await collectionsSaveRoute.handler(
      new Request(`https://x.test/v1/collections/${collectionId}`, {
        method: 'PUT',
        body: JSON.stringify({ expectedRevision: 1, name: 'Spokojne formy', fields: publishableFields }),
      }),
      {} as CloudflareEnv,
      { id: collectionId },
      ctx,
    );
    expect(saveRes.status).toBe(200);
    const saved = await saveRes.json();
    expect(saved.revision).toBe(2);
    expect(saved.publishedRevision).toBeNull();
    expect(saved.fields).toEqual(publishableFields);

    // 3. publish — at the freshly-saved revision, with a valid product id in
    // the productIds field, so product_ref_invalid/missing_polish are both
    // avoided; publishedRevision catches up to the draft revision.
    const publishRes = await collectionsPublicationPostRoute.handler(
      new Request(`https://x.test/v1/collections/${collectionId}/publication`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'publish-key' },
        body: JSON.stringify({ expectedRevision: 2 }),
      }),
      {} as CloudflareEnv,
      { id: collectionId },
      ctx,
    );
    expect(publishRes.status).toBe(200);
    const published = await publishRes.json();
    expect(published.revision).toBe(2);
    expect(published.publishedRevision).toBe(2);

    // 4. restore — restores the ORIGINAL revision 1 (the blank-pl-field
    // default draft), which must land as a brand-new revision 3 without
    // touching publishedRevision (Global Constraint 19 / restore_collection_draft
    // never writes collections.published_revision).
    const restoreRes = await collectionsRestorePostRoute.handler(
      new Request(`https://x.test/v1/collections/${collectionId}/restore`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'restore-key' },
        body: JSON.stringify({ expectedRevision: 2, sourceRevision: 1 }),
      }),
      {} as CloudflareEnv,
      { id: collectionId },
      ctx,
    );
    expect(restoreRes.status).toBe(200);
    const restored = await restoreRes.json();
    expect(restored.revision).toBe(3);
    expect(restored.publishedRevision).toBe(2);
    expect(restored.fields).toHaveLength(5);
    const restoredPlField = restored.fields.find((f: Field) => f.locale === 'pl');
    // The restored payload is revision 1's (the original blank-pl default
    // draft), not revision 2's (the published one) — proves restore copied
    // the OLD draft, not "whatever is current".
    expect(restoredPlField?.value).toBe('');

    // Idempotency was engaged for the three idempotent operations (create,
    // publish, restore); save has no Idempotency-Key — it relies solely on
    // expectedRevision optimistic concurrency, same as products-save.ts.
    expect(idempotency.claimIdempotencyKey).toHaveBeenCalledTimes(3);
    expect(idempotency.completeIdempotencyKey).toHaveBeenCalledTimes(3);
    expect(idempotency.releaseIdempotencyKey).not.toHaveBeenCalled();
  });
});
