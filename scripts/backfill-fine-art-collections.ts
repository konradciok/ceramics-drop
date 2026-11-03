#!/usr/bin/env node
/**
 * One-time backfill: creates and publishes the 9 real fine-art-print
 * collections (currently only in config/print-catalog-curation.json) in
 * the collections/collection_drafts tables, via the real
 * create_collection_with_draft / publish_collection_revision RPCs — the
 * same code path the CMS itself uses.
 *
 * Idempotent and resumable: a collection whose revision-1 draft already
 * exists AND is published (collections.published_revision = 1) is skipped.
 * One whose revision-1 draft exists but was never published — e.g.
 * create_collection_with_draft succeeded on a prior run but
 * publish_collection_revision then failed or the run was interrupted — is
 * published (reusing its existing collection_id) instead of being skipped
 * or recreated. Only a name with no revision-1 draft at all is created from
 * scratch. This way a re-run after a partial failure both avoids duplicates
 * and completes the interrupted publish, rather than leaving the collection
 * permanently unpublished (and so excluded from the storefront, which only
 * reads collections with a non-null published_revision).
 *
 * Usage:
 *   npm run backfill:fine-art-collections
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars / env),
 * pointed at the target project explicitly before running — this writes
 * real, permanent rows (collections have no delete API) to whichever
 * project those credentials belong to. Confirm the target before running.
 *
 * `runBackfill` / `buildFields` / `generateCollectionId` are exported so
 * this module can be imported by scripts/backfill-fine-art-collections.test.ts
 * without executing main() — see the invokedAsScript guard at the bottom,
 * the same pattern used by scripts/orders-cli.ts and scripts/prodigi-cli.ts.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import curationSource from '../config/print-catalog-curation.json';
import { loadLocalEnv, loadSupabaseClient } from './lib/script-env';

type CurationCollection = { slug: string; name: string; prints: { productId: string }[] };
type CurationSource = { collections: CurationCollection[] };

const source = curationSource as CurationSource;

export function generateCollectionId(): string {
  return `col_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export function buildFields(name: string, slug: string, productIds: string[]) {
  return [
    // Honest, deliberate placeholder (docs/plans/2026-09-16-fine-art-collections-migration.md:182-186):
    // real copy is written later by the content owner through the CMS. Must
    // stay non-blank — publish_collection_revision's missing_polish check
    // (supabase/migrations/20260915120000_cms_api_collections.sql:242-256)
    // requires at least one non-blank locale:'pl' field, and this is the
    // only one buildFields supplies.
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: `${name}.`, locale: 'pl', sourceLocale: 'pl' },
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'en', sourceLocale: 'pl' },
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'es', sourceLocale: 'pl' },
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'de', sourceLocale: 'pl' },
    { key: 'products', label: 'Produkty i kolejność', type: 'productIds', value: productIds.join(','), locale: 'none', sourceLocale: 'none' },
    { key: 'slug', label: 'Slug', type: 'text', value: slug, locale: 'none', sourceLocale: 'none' },
    // Scopes this collection into the fine-art-print storefront sections —
    // see src/lib/print-collections.ts's loadPrintCollectionDefinitions,
    // which only includes collections carrying this exact field/value. A
    // collection created via the CMS's generic "+ Nowa kolekcja" button has
    // no `kind` field and is safely excluded by default.
    { key: 'kind', label: 'Rodzaj', type: 'text', value: 'print-collection', locale: 'none', sourceLocale: 'none' },
  ];
}

export async function runBackfill(supabase: SupabaseClient): Promise<void> {
  const actorEmail = 'backfill-script@ceramics-drop.internal';

  const { data: existingRevisionOnes, error: existingError } = await supabase
    .from('collection_drafts')
    .select('collection_id, payload')
    .eq('revision', 1);
  if (existingError) throw existingError;
  const existingIdByName = new Map<string, string>(
    (existingRevisionOnes ?? [])
      .map((row) => [(row.payload as { name?: string })?.name, row.collection_id as string] as const)
      .filter((entry): entry is [string, string] => typeof entry[0] === 'string'),
  );

  // A revision-1 collection_drafts row only proves create_collection_with_draft
  // ran — creation and publication are separate RPCs (below), so a prior run
  // that crashed or errored between them leaves that name here with no
  // matching publish. Load publication state for every such name so the loop
  // can tell "already fully published, skip" apart from "draft exists but
  // was never published, resume it".
  const existingIds = [...existingIdByName.values()];
  const { data: existingCollections, error: collectionsError } = existingIds.length
    ? await supabase.from('collections').select('id, published_revision').in('id', existingIds)
    : { data: [] as { id: string; published_revision: number | null }[], error: null };
  if (collectionsError) throw collectionsError;
  const publishedRevisionById = new Map<string, number | null>(
    (existingCollections ?? []).map((row) => [row.id as string, row.published_revision as number | null]),
  );

  for (const collection of source.collections) {
    const existingId = existingIdByName.get(collection.name);
    if (existingId) {
      // Only revision 1 is ever created by this script, so "published"
      // means published_revision === 1 exactly. Anything else (still null,
      // or advanced past 1 by a later CMS edit) is not the untouched happy
      // path this backfill owns — fall through to publish_collection_revision
      // below, which either completes the interrupted publish (the common
      // case) or raises a clear `revision_conflict` / `collection_not_found`
      // rather than this script silently skipping an unpublished collection
      // or attempting to create a duplicate.
      if (publishedRevisionById.get(existingId) === 1) {
        console.log(`skip: "${collection.name}" already exists and is published`);
        continue;
      }

      console.log(`resuming: "${collection.name}" (${existingId}) has a draft but was never published — publishing`);
      const { error: publishError } = await supabase.rpc('publish_collection_revision', {
        p_collection_id: existingId,
        p_expected_revision: 1,
        p_actor_email: actorEmail,
      });
      if (publishError) throw publishError;
      console.log(`published: "${collection.name}" (${existingId})`);
      continue;
    }

    const productIds = collection.prints.map((p) => p.productId);
    const fields = buildFields(collection.name, collection.slug, productIds);
    let collectionId = generateCollectionId();

    let created = false;
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      const { error } = await supabase.rpc('create_collection_with_draft', {
        p_id: collectionId,
        p_payload: { name: collection.name, fields },
        p_actor_email: actorEmail,
      });
      if (!error) {
        created = true;
        break;
      }
      if (error.code === '23505' && attempt < 2) {
        collectionId = generateCollectionId();
        continue;
      }
      throw error;
    }
    // Every exit path above either sets `created` or throws — this makes
    // that invariant explicit rather than silently trusting it, in case a
    // future edit adds a `break` that skips setting it.
    if (!created) throw new Error(`unreachable: exited the create retry loop for "${collection.name}" without creating or throwing`);

    const { error: publishError } = await supabase.rpc('publish_collection_revision', {
      p_collection_id: collectionId,
      p_expected_revision: 1,
      p_actor_email: actorEmail,
    });
    if (publishError) throw publishError;

    console.log(`created + published: "${collection.name}" (${collectionId}, ${productIds.length} products)`);
  }

  console.log('\nFine-art collections backfill complete.');
}

async function main(): Promise<void> {
  // Collections have no delete API, so a misdirected run (e.g. .env.local
  // accidentally pointing at production during what was meant to be a test
  // run) creates permanent, hard-to-clean rows. loadSupabaseClient() throws
  // first if the target env vars are missing; only once that's confirmed
  // present do we log the resolved target host and what's about to be
  // written, before the first RPC write — giving a human running the script
  // a chance to Ctrl+C if the target looks wrong.
  const supabase = loadSupabaseClient();
  const env = loadLocalEnv();
  console.log(`Target: ${new URL(env.SUPABASE_URL!).host}`);
  console.log(`Will process: ${source.collections.map((c) => c.name).join(', ')}`);
  await runBackfill(supabase);
}

// Guard so importing this module for tests (backfill-fine-art-collections.test.ts)
// doesn't also run main() — same invokedAsScript pattern as orders-cli.ts /
// prodigi-cli.ts.
const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
