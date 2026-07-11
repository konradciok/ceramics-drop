/**
 * Publish a verified revision: atomically assign its `ready` assets to every
 * active variant via the `publish_print_asset_revision` RPC (Phase 2b of the
 * print-asset pipeline — docs/plans/print-asset-pipeline.md → Phase 2 `publish`
 * bullets).
 *
 * Resolves each manifest derivative to the uuid of its `ready`
 * `print_fulfilment_assets` row, maps every active variant to its profile's
 * asset, and hands the (variant_key, asset_id) set to the RPC. The RPC re-checks
 * exact variant coverage, per-asset readiness, ownership, and dimensions inside
 * one transaction under a product lock, so a bad set leaves the prior assignment
 * live (plan §3). This script never writes assignment rows directly.
 *
 * Publishing is a live cutover, so it requires explicit confirmation:
 * `--confirm <revision>` must echo the revision being published.
 *
 * Usage:
 *   npm run print-assets:publish -- --product fap01 --revision 2026-07-11-r1 --dry-run
 *   npm run print-assets:publish -- --product fap01 --revision 2026-07-11-r1 --confirm 2026-07-11-r1
 */
import { buildPublishAssignments } from '../src/lib/print-assets-publish';
import { loadSupabaseClient } from './lib/script-env';
import { getArg, hasFlag, loadManifest } from './lib/print-assets-cli';

async function main(): Promise<void> {
  const productId = getArg('product');
  const revision = getArg('revision');
  const confirm = getArg('confirm');
  const dryRun = hasFlag('dry-run');

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');
  if (!revision) throw new Error('Missing --revision (e.g. --revision 2026-07-11-r1)');
  if (!dryRun && confirm !== revision) {
    throw new Error(
      `Refusing to publish without confirmation. Re-run with --confirm ${revision} ` +
        '(or --dry-run to preview the assignments).',
    );
  }

  const manifest = loadManifest(productId, revision);
  const supabase = loadSupabaseClient();
  console.log(`print-assets:publish — product=${productId} revision=${revision}${dryRun ? '  [DRY RUN]' : ''}`);

  // Resolve every derivative's ready asset id. Only `ready` rows are eligible —
  // buildPublishAssignments fails closed if any profile has no ready row, and
  // the RPC re-validates readiness regardless.
  const ready = await supabase
    .from('print_fulfilment_assets')
    .select('id, r2_key')
    .eq('product_id', productId)
    .eq('revision', revision)
    .eq('status', 'ready');
  if (ready.error) throw new Error(`Failed to read ready assets: ${ready.error.message}`);

  const assetIdByR2Key = new Map((ready.data ?? []).map((r) => [r.r2_key as string, r.id as string]));
  const assignments = buildPublishAssignments(manifest, assetIdByR2Key);

  console.log(`  ${assignments.length} variant assignment(s) across ${manifest.derivatives.length} derivative(s):`);
  for (const a of assignments) {
    console.log(`    ${a.variant_key}  →  ${a.asset_id}`);
  }

  if (dryRun) {
    console.log('\nDRY RUN — no assignments written. Re-run with --confirm to publish.');
    return;
  }

  const published = await supabase.rpc('publish_print_asset_revision', {
    p_product_id: productId,
    p_revision: revision,
    p_assignments: assignments,
  });
  if (published.error) throw new Error(`publish_print_asset_revision failed: ${published.error.message}`);

  const result = Array.isArray(published.data) ? published.data[0] : published.data;
  console.log(
    `\nDone. Revision ${revision} is live: ${result?.assigned_count ?? assignments.length} variant assignment(s) ` +
      `for ${productId}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
