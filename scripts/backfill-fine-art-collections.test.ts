import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import curationSource from '../config/print-catalog-curation.json';
import { buildFields, runBackfill } from './backfill-fine-art-collections';

type RpcCall = { p_id?: string; p_payload?: unknown; p_collection_id?: string; p_expected_revision?: number; p_actor_email?: string };

interface FakeSupabaseConfig {
  /** Names already present among revision-1 collection_drafts payloads. */
  existingNames?: string[];
  existingError?: { message: string } | null;
  /** Called once per create_collection_with_draft invocation (0-indexed per script run, not per collection). */
  createBehavior?: (params: RpcCall, callIndex: number) => { error: { code?: string; message?: string } | null };
  publishBehavior?: (params: RpcCall) => { error: { message?: string } | null };
}

function fakeSupabase(config: FakeSupabaseConfig) {
  const createCalls: RpcCall[] = [];
  const publishCalls: RpcCall[] = [];

  const supabase = {
    from: (table: string) => {
      if (table !== 'collection_drafts') {
        throw new Error(`fakeSupabase: unexpected table "${table}"`);
      }
      return {
        select: () => ({
          eq: (..._args: unknown[]) =>
            Promise.resolve({
              data: (config.existingNames ?? []).map((name) => ({ payload: { name } })),
              error: config.existingError ?? null,
            }),
        }),
      };
    },
    rpc: (fn: string, params: RpcCall) => {
      if (fn === 'create_collection_with_draft') {
        createCalls.push(params);
        const result = config.createBehavior
          ? config.createBehavior(params, createCalls.length - 1)
          : { error: null };
        return Promise.resolve(result);
      }
      if (fn === 'publish_collection_revision') {
        publishCalls.push(params);
        const result = config.publishBehavior ? config.publishBehavior(params) : { error: null };
        return Promise.resolve(result);
      }
      throw new Error(`fakeSupabase: unexpected rpc "${fn}"`);
    },
  } as unknown as SupabaseClient;

  return { supabase, createCalls, publishCalls };
}

const ALL_NAMES = (curationSource as { collections: { name: string }[] }).collections.map((c) => c.name);

describe('buildFields', () => {
  it('produces 4 blank locale description fields, a products field, a slug field, and a kind field, in that order (7 fields)', () => {
    const fields = buildFields('Ostrea', 'ostrea', ['fap001', 'fap002', 'fap003']);
    expect(fields).toHaveLength(7);
    expect(fields).toEqual([
      { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'pl', sourceLocale: 'pl' },
      { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'en', sourceLocale: 'pl' },
      { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'es', sourceLocale: 'pl' },
      { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'de', sourceLocale: 'pl' },
      { key: 'products', label: 'Produkty i kolejność', type: 'productIds', value: 'fap001,fap002,fap003', locale: 'none', sourceLocale: 'none' },
      { key: 'slug', label: 'Slug', type: 'text', value: 'ostrea', locale: 'none', sourceLocale: 'none' },
      { key: 'kind', label: 'Rodzaj', type: 'text', value: 'print-collection', locale: 'none', sourceLocale: 'none' },
    ]);
  });
});

describe('runBackfill', () => {
  it('skips a collection whose name already exists among revision-1 drafts, without recreating it', async () => {
    const { supabase, createCalls, publishCalls } = fakeSupabase({ existingNames: ['Ostrea'] });

    await runBackfill(supabase);

    // The 8 collections not already present get created + published; the
    // pre-existing "Ostrea" is skipped entirely.
    expect(createCalls).toHaveLength(ALL_NAMES.length - 1);
    expect(publishCalls).toHaveLength(ALL_NAMES.length - 1);
    const createdNames = createCalls.map((c) => (c.p_payload as { name: string }).name);
    expect(createdNames).not.toContain('Ostrea');
    expect(new Set(createdNames)).toEqual(new Set(ALL_NAMES.filter((n) => n !== 'Ostrea')));
  });

  it('does nothing when every collection name already exists', async () => {
    const { supabase, createCalls, publishCalls } = fakeSupabase({ existingNames: ALL_NAMES });

    await runBackfill(supabase);

    expect(createCalls).toHaveLength(0);
    expect(publishCalls).toHaveLength(0);
  });

  it('retries with a new generated id when create_collection_with_draft hits a unique-violation (23505), then publishes the id that succeeded', async () => {
    // Isolate to a single collection ("Ostrea") by marking every other name
    // as already existing.
    const { supabase, createCalls, publishCalls } = fakeSupabase({
      existingNames: ALL_NAMES.filter((n) => n !== 'Ostrea'),
      createBehavior: (_params, callIndex) =>
        callIndex === 0 ? { error: { code: '23505', message: 'duplicate key value violates unique constraint' } } : { error: null },
    });

    await runBackfill(supabase);

    expect(createCalls).toHaveLength(2);
    expect(createCalls[0].p_payload).toMatchObject({ name: 'Ostrea' });
    expect(createCalls[1].p_payload).toMatchObject({ name: 'Ostrea' });
    // Retry generates a fresh id rather than reusing the collided one.
    expect(createCalls[1].p_id).not.toBe(createCalls[0].p_id);

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toMatchObject({
      p_collection_id: createCalls[1].p_id,
      p_expected_revision: 1,
    });
  });

  it('gives up after 3 failed create attempts and does not publish', async () => {
    const { supabase, createCalls, publishCalls } = fakeSupabase({
      existingNames: ALL_NAMES.filter((n) => n !== 'Ostrea'),
      createBehavior: () => ({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } }),
    });

    await expect(runBackfill(supabase)).rejects.toMatchObject({ code: '23505' });

    expect(createCalls).toHaveLength(3);
    expect(publishCalls).toHaveLength(0);
  });

  it('propagates a non-23505 create error immediately, without retrying', async () => {
    const { supabase, createCalls, publishCalls } = fakeSupabase({
      existingNames: ALL_NAMES.filter((n) => n !== 'Ostrea'),
      createBehavior: () => ({ error: { message: 'connection reset' } }),
    });

    await expect(runBackfill(supabase)).rejects.toMatchObject({ message: 'connection reset' });

    expect(createCalls).toHaveLength(1);
    expect(publishCalls).toHaveLength(0);
  });

  it('propagates a publish error', async () => {
    const { supabase, publishCalls } = fakeSupabase({
      existingNames: ALL_NAMES.filter((n) => n !== 'Ostrea'),
      publishBehavior: () => ({ error: { message: 'revision_conflict' } }),
    });

    await expect(runBackfill(supabase)).rejects.toMatchObject({ message: 'revision_conflict' });

    expect(publishCalls).toHaveLength(1);
  });

  it('throws when the existing-drafts lookup errors', async () => {
    const { supabase } = fakeSupabase({ existingError: { message: 'Database connection failed' } });

    await expect(runBackfill(supabase)).rejects.toMatchObject({ message: 'Database connection failed' });
  });
});
