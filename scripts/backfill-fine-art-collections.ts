#!/usr/bin/env node
/**
 * One-time backfill: creates and publishes the 9 real fine-art-print
 * collections (currently only in config/print-catalog-curation.json) in
 * the collections/collection_drafts tables, via the real
 * create_collection_with_draft / publish_collection_revision RPCs — the
 * same code path the CMS itself uses.
 *
 * Idempotent: skips any collection whose name already exists among
 * collection_drafts payloads, so a re-run after a partial failure does
 * not create duplicates.
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
    // Left blank rather than a generated `${name}.` placeholder — a blank
    // field reads as genuinely unwritten to an operator editing the
    // collection later; a pre-filled one reads as authored (but wrong) copy.
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'pl', sourceLocale: 'pl' },
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
    .select('payload')
    .eq('revision', 1);
  if (existingError) throw existingError;
  const existingNames = new Set(
    (existingRevisionOnes ?? []).map((row) => (row.payload as { name?: string })?.name),
  );

  for (const collection of source.collections) {
    if (existingNames.has(collection.name)) {
      console.log(`skip: "${collection.name}" already exists`);
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
