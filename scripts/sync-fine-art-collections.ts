#!/usr/bin/env node
/**
 * Syncs the 9 published fine-art-print collections' membership/order in
 * Supabase (`collections`/`collection_drafts`) to whatever
 * config/print-catalog-curation.json currently authors — the same
 * save_collection_draft / publish_collection_revision RPCs the CMS uses.
 *
 * Unlike scripts/backfill-fine-art-collections.ts (a one-time creation
 * script, now a no-op for these 9 names), this is an UPDATE tool: every
 * targeted collection must already exist and be published — it never
 * creates one. A collection whose desired `products` CSV already matches
 * the live published payload is left untouched (no draft/publish call at
 * all), so a repeat run after a successful sync is a clean no-op.
 *
 * Every other field on the payload (description, slug, kind) is carried
 * over byte-for-byte from the current published draft — only the
 * `products` field's `value` changes.
 *
 * Usage:
 *   npm run sync:fine-art-collections            # dry-run: prints the diff, writes nothing
 *   npm run sync:fine-art-collections -- --confirm  # writes + publishes for real
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars / env),
 * pointed at the target project explicitly before running — --confirm writes
 * real, permanent rows (collections have no delete API) to whichever project
 * those credentials belong to. Confirm the target before running with --confirm.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import curationSource from '../config/print-catalog-curation.json';
import { loadLocalEnv, loadSupabaseClient } from './lib/script-env';

type CurationCollection = { slug: string; name: string; prints: { productId: string }[] };
type CurationSource = { collections: CurationCollection[] };

type PayloadField = { key: string; label: string; type: string; value: string; locale: string; sourceLocale: string };
type CollectionPayload = { name: string; fields: PayloadField[] };

const source = curationSource as CurationSource;

function productIdsOf(payload: CollectionPayload): string {
  return payload.fields.find((f) => f.key === 'products')?.value ?? '';
}

function withProductIds(payload: CollectionPayload, value: string): CollectionPayload {
  return {
    ...payload,
    fields: payload.fields.map((f) => (f.key === 'products' ? { ...f, value } : f)),
  };
}

/** The live, currently-published row for one collection, keyed by name. */
type PublishedRow = { collectionId: string; revision: number; payload: CollectionPayload };

async function loadPublishedPrintCollectionsByName(supabase: SupabaseClient): Promise<Map<string, PublishedRow>> {
  const { data: collections, error: collectionsError } = await supabase
    .from('collections')
    .select('id, published_revision')
    .not('published_revision', 'is', null);
  if (collectionsError) throw collectionsError;
  if (!collections || collections.length === 0) return new Map();

  // Fetch exactly one row per collection — its published revision — via an
  // OR of (collection_id, revision) pairs, never the full draft history.
  // Filtering "revision = published_revision" in JS after an unbounded
  // `.in('collection_id', ids)` select would silently truncate under
  // Supabase's default ~1000-row page size once enough historical
  // revisions accumulate, possibly dropping the one row a collection
  // actually needs. This way the result set is bounded by
  // `collections.length`, never by total revision count.
  const orFilter = collections
    .map((c) => `and(collection_id.eq.${c.id},revision.eq.${c.published_revision})`)
    .join(',');
  const { data: drafts, error: draftsError } = await supabase
    .from('collection_drafts')
    .select('collection_id, revision, payload')
    .or(orFilter);
  if (draftsError) throw draftsError;

  const byName = new Map<string, PublishedRow>();
  for (const row of drafts ?? []) {
    const payload = row.payload as CollectionPayload;
    if (typeof payload?.name !== 'string') continue;
    const isPrintCollection = (payload.fields ?? []).some((f) => f.key === 'kind' && f.value === 'print-collection');
    if (!isPrintCollection) continue;

    byName.set(payload.name, { collectionId: row.collection_id as string, revision: row.revision as number, payload });
  }
  return byName;
}

/** The newest saved revision for a collection, published or not — used to
 *  detect a pending CMS edit before this script bases a write on the
 *  (older) published payload. */
async function latestDraftRevision(supabase: SupabaseClient, collectionId: string): Promise<number> {
  const { data, error } = await supabase
    .from('collection_drafts')
    .select('revision')
    .eq('collection_id', collectionId)
    .order('revision', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.revision as number | undefined) ?? 0;
}

export async function runSync(supabase: SupabaseClient, { confirm }: { confirm: boolean }): Promise<void> {
  const actorEmail = 'sync-fine-art-collections-script@ceramics-drop.internal';
  const publishedByName = await loadPublishedPrintCollectionsByName(supabase);

  let changedCount = 0;
  for (const collection of source.collections) {
    const desiredIds = collection.prints.map((p) => p.productId).join(',');
    const live = publishedByName.get(collection.name);
    if (!live) {
      throw new Error(
        `"${collection.name}" has no live published print-collection in this Supabase project — this script only ` +
        'updates existing collections. Run scripts/backfill-fine-art-collections.ts first, or check the target project.',
      );
    }

    const liveIds = productIdsOf(live.payload);
    if (liveIds === desiredIds) {
      console.log(`no-op: "${collection.name}" already matches (${collection.prints.length} products)`);
      continue;
    }

    changedCount += 1;
    console.log(`\nCHANGE: "${collection.name}"`);
    console.log(`  old: ${liveIds || '(empty)'}`);
    console.log(`  new: ${desiredIds}`);

    // A newer, unpublished draft (e.g. a pending CMS edit) means the
    // published payload this diff is based on is stale. Writing anyway
    // would either be rejected by save_collection_draft's own optimistic-
    // concurrency check (p_expected_revision no longer matches the latest
    // revision) or, worse, silently discard that pending draft's edits by
    // basing the new revision on the older published payload instead of it.
    const latestRevision = await latestDraftRevision(supabase, live.collectionId);
    if (latestRevision !== live.revision) {
      console.log(
        `  PENDING DRAFT: revision ${latestRevision} exists but published is only ${live.revision} — ` +
        'resolve (publish or discard) that draft in the CMS before syncing this collection.',
      );
      if (confirm) {
        throw new Error(`"${collection.name}" has a pending unpublished draft — aborting before writing it.`);
      }
      continue;
    }

    if (!confirm) continue;

    const newPayload = withProductIds(live.payload, desiredIds);
    const { error: saveError } = await supabase.rpc('save_collection_draft', {
      p_collection_id: live.collectionId,
      p_expected_revision: live.revision,
      p_payload: newPayload,
      p_actor_email: actorEmail,
    });
    if (saveError) throw saveError;

    const newRevision = live.revision + 1;
    const { error: publishError } = await supabase.rpc('publish_collection_revision', {
      p_collection_id: live.collectionId,
      p_expected_revision: newRevision,
      p_actor_email: actorEmail,
    });
    if (publishError) throw publishError;

    console.log(`  published revision ${newRevision}`);
  }

  console.log(
    confirm
      ? `\nSync complete: ${changedCount} collection(s) published.`
      : `\nDry run complete: ${changedCount} collection(s) would change. Re-run with --confirm to publish.`,
  );
}

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const supabase = loadSupabaseClient();
  const env = loadLocalEnv();
  console.log(`Target: ${new URL(env.SUPABASE_URL!).host}`);
  console.log(confirm ? 'Mode: LIVE (--confirm passed) — will publish changes' : 'Mode: dry-run (pass --confirm to publish)');
  await runSync(supabase, { confirm });
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
