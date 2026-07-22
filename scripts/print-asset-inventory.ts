/**
 * READ-ONLY inventory of legacy `{productId}/master.jpg` objects in the
 * print-assets R2 bucket. Records the remote asset baseline before later
 * pipeline phases switch key semantics to content-addressed keys.
 *
 * Run: npm run print-assets:inventory [-- --dry-run] [-- --json] [-- --allow-missing]
 *
 * Design enumeration follows the storefront catalogue (`getPrintDesigns()`),
 * not the code registry alone — under CATALOG_SOURCE=db (production) that reads
 * active print rows from Supabase; with CATALOG_SOURCE=code it falls back to
 * published registry designs.
 *
 * Existence probes use Wrangler `r2 object get --remote --pipe`, which streams
 * the full object (Wrangler 4.x has no `head`). Acceptable for ~3 designs today;
 * Phase 2 verify should use R2Bucket.head() via the Worker binding instead.
 *
 * Read-only guarantee: the only wrangler subcommand this script ever invokes
 * is `r2 object get` (never `put` / `delete`). A reviewer can confirm by
 * grepping for 'put' / 'delete' — there are none.
 *
 * Exit codes: 0 when every enumerated design has a legacy master (or
 * --allow-missing); 1 when any design is absent unless --allow-missing.
 */
import { spawnSync } from 'node:child_process';
import { getPrintDesigns } from '../src/lib/prints';

// Bucket name default matches wrangler.jsonc → r2_buckets[0].bucket_name.
// Override via PRINT_ASSETS_BUCKET for non-prod buckets.
const BUCKET = process.env.PRINT_ASSETS_BUCKET ?? 'anna-ciok-print-assets';

/** Legacy pre-pipeline master-object key used only by the read-only inventory probe. */
const printAssetKey = (productId: string): string => `${productId}/master.jpg`;

const dryRun = process.argv.includes('--dry-run');
const jsonOut = process.argv.includes('--json');
const allowMissing = process.argv.includes('--allow-missing');

interface ProbeResult {
  id: string;
  key: string;
  present: boolean;
  error?: string;
}

interface InventoryReport {
  bucket: string;
  catalogueSource: string;
  dryRun: boolean;
  probes: ProbeResult[];
  summary: { total: number; present: number; absent: number };
}

/**
 * Probe a single R2 key for existence.
 *
 * Wrangler 4.x has no `r2 object head`; `get --pipe` streams bytes to stdout
 * (discarded here). Exit 0 = object present; non-zero = absent or error.
 * Chosen over `get --file <tmp>` to avoid writing a throwaway file per probe.
 */
function probeKey(bucket: string, key: string): Omit<ProbeResult, 'id' | 'key'> {
  const res = spawnSync(
    'npx',
    ['wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--pipe'],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
  );
  if (res.status === 0) return { present: true };
  const error =
    (res.stderr ?? '').trim() ||
    res.error?.message ||
    `exit ${res.status ?? 'null'}`;
  return { present: false, error };
}

async function main(): Promise<void> {
  const designs = await getPrintDesigns();
  const catalogueSource = process.env.CATALOG_SOURCE === 'db' ? 'db' : 'code';

  if (!jsonOut) {
    console.log(
      `Print-asset inventory — ${designs.length} published design(s), bucket: ${BUCKET}, catalogue: ${catalogueSource}`,
    );
  }

  const results: ProbeResult[] = [];

  for (const d of designs) {
    const key = printAssetKey(d.id);

    if (dryRun) {
      results.push({ id: d.id, key, present: false });
      continue;
    }

    if (!jsonOut) process.stdout.write(`  ${d.id}  ${key}  … `);
    const probe = probeKey(BUCKET, key);
    if (!jsonOut) {
      console.log(
        probe.present ? 'present' : `absent${probe.error ? ` (${probe.error})` : ''}`,
      );
    }
    results.push({ id: d.id, key, ...probe });
  }

  const present = results.filter((r) => r.present).length;
  const absent = results.length - present;
  const report: InventoryReport = {
    bucket: BUCKET,
    catalogueSource,
    dryRun,
    probes: results,
    summary: { total: results.length, present, absent },
  };

  if (dryRun && !jsonOut) {
    console.log('DRY RUN — no wrangler calls made. Keys that would be probed:');
    for (const r of results) {
      console.log(`  ${r.id}  ${BUCKET}/${r.key}`);
    }
    console.log(`\nWould report ${results.length} probe(s) against bucket: ${BUCKET}`);
  } else if (!jsonOut) {
    console.log(`\n${present} / ${results.length} published designs have a legacy master object`);
  }

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  }

  if (!dryRun && absent > 0 && !allowMissing) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
