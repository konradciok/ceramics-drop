/* The migration's inline seed row and DEFAULT_PRINT_PRICING are documented as
   twins (seed source + outage fallback). That lockstep was comment-enforced
   only — this test parses the actual SQL so editing one without the other
   fails CI instead of silently drifting (flagged in PR #235 review). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINT_PRICING, derivePrice } from '../print-pricing';

const MIGRATIONS_DIR = join(__dirname, '../../../supabase/migrations');
const SEED_MIGRATION = join(MIGRATIONS_DIR, '20260807120000_print_pricing_config.sql');
const CANONICAL_MIGRATION = join(MIGRATIONS_DIR, '20261102120000_print_prices_canonical.sql');

const stripComments = (s: string) => s.replace(/--[^\n]*/g, '');

/** The seed row as a fresh database ends up with it: the original insert,
    then the canonical migration's guarded update (its `set` clause). */
function seededConfig(): Record<string, number> {
  const sql = readFileSync(SEED_MIGRATION, 'utf8');
  const insert = sql.match(
    /insert into print_pricing_config\s*\(([\s\S]*?)\)\s*values\s*\(([\s\S]*?)\);/i,
  );
  expect(insert, 'seed insert statement not found').not.toBeNull();
  const columns = stripComments(insert![1]).split(',').map((c) => c.trim()).filter(Boolean);
  const values = stripComments(insert![2]).split(',').map((v) => Number(v.trim()));
  expect(columns).toHaveLength(values.length);
  const seeded: Record<string, number> = Object.fromEntries(columns.map((c, i) => [c, values[i]]));

  const update = stripComments(readFileSync(CANONICAL_MIGRATION, 'utf8')).match(
    /update print_pricing_config set([\s\S]*?)\bwhere\b/i,
  );
  expect(update, 'canonical config update not found').not.toBeNull();
  for (const [, col, val] of update![1].matchAll(/(\w+)\s*=\s*([\d.]+)/g)) seeded[col] = Number(val);
  return seeded;
}

describe('print_pricing_config migration seed', () => {
  it('ends at DEFAULT_PRINT_PRICING exactly after all migrations (by column name, order-independent)', () => {
    const d = DEFAULT_PRINT_PRICING;
    expect(seededConfig()).toEqual({
      base_30x40_eur: d.baseEur['30x40'], base_50x70_eur: d.baseEur['50x70'], base_70x100_eur: d.baseEur['70x100'],
      frame_30x40_eur: d.frameEur['30x40'], frame_50x70_eur: d.frameEur['50x70'], frame_70x100_eur: d.frameEur['70x100'],
      mount_30x40_eur: d.mountEur['30x40'], mount_50x70_eur: d.mountEur['50x70'], mount_70x100_eur: d.mountEur['70x100'],
      eur_to_pln: d.eurToPln, eur_to_gbp: d.eurToGbp,
    });
  });

  it('pins the product_variants price literals in the canonical migration to derivePrice()', () => {
    const sql = stripComments(readFileSync(CANONICAL_MIGRATION, 'utf8'));
    const rows = [...sql.matchAll(/\('(\d+x\d+)',\s*([\d,\s]+)\)/g)];
    expect(rows).toHaveLength(3);
    const d = DEFAULT_PRINT_PRICING;
    for (const [, size, nums] of rows) {
      const [bEur, fEur, mEur, bPln, fPln, mPln, bGbp, fGbp, mGbp] = nums.split(',').map((n) => Number(n.trim()));
      const s = size as keyof typeof d.baseEur;
      expect([bEur, fEur, mEur]).toEqual([d.baseEur[s], d.frameEur[s], d.mountEur[s]]);
      expect([bPln, fPln, mPln]).toEqual([d.baseEur[s], d.frameEur[s], d.mountEur[s]].map((e) => derivePrice(e, 'pln', d)));
      expect([bGbp, fGbp, mGbp]).toEqual([d.baseEur[s], d.frameEur[s], d.mountEur[s]].map((e) => derivePrice(e, 'gbp', d)));
    }
  });
});
