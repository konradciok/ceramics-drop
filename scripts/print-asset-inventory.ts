/**
 * READ-ONLY inventory of legacy `{productId}/master.jpg` objects in the
 * print-assets R2 bucket. Records the remote asset baseline before later
 * pipeline phases switch key semantics to content-addressed keys.
 *
 * Run: npm run print-assets:inventory [-- --dry-run]
 *
 * Read-only guarantee: the only wrangler subcommand this script ever invokes
 * is `r2 object get` (never `put` / `delete`). A reviewer can confirm by
 * grepping for 'put' / 'delete' — there are none.
 */
import { spawnSync } from 'node:child_process';
import { registryPrintDesigns } from '../src/lib/prints';
import { printAssetKey } from '../src/lib/print-assets';

// Bucket name default matches wrangler.jsonc → r2_buckets[0].bucket_name.
// Override via PRINT_ASSETS_BUCKET for non-prod buckets.
const BUCKET = process.env.PRINT_ASSETS_BUCKET ?? 'anna-ciok-print-assets';

const dryRun = process.argv.includes('--dry-run');

interface ProbeResult {
  id: string;
  key: string;
  present: boolean;
  error?: string;
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
  const error = (res.stderr ?? '').trim() || `exit ${res.status ?? 'null'}`;
  return { present: false, error };
}

function main(): void {
  const designs = registryPrintDesigns();
  console.log(
    `Print-asset inventory — ${designs.length} published design(s), bucket: ${BUCKET}`,
  );

  const results: ProbeResult[] = [];

  for (const d of designs) {
    const key = printAssetKey(d.id);

    if (dryRun) {
      results.push({ id: d.id, key, present: false });
      continue;
    }

    process.stdout.write(`  ${d.id}  ${key}  … `);
    const probe = probeKey(BUCKET, key);
    console.log(
      probe.present ? 'present' : `absent${probe.error ? ` (${probe.error})` : ''}`,
    );
    results.push({ id: d.id, key, ...probe });
  }

  if (dryRun) {
    console.log('DRY RUN — no wrangler calls made. Keys that would be probed:');
    for (const r of results) {
      console.log(`  ${r.id}  ${BUCKET}/${r.key}`);
    }
    console.log(`\nWould report ${results.length} probe(s) against bucket: ${BUCKET}`);
    return;
  }

  const present = results.filter((r) => r.present).length;
  console.log(`\n${present} / ${results.length} published designs have a legacy master object`);
}

main();
