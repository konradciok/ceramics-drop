/* The migration's inline seed row and DEFAULT_PRINT_PRICING are documented as
   twins (seed source + outage fallback). That lockstep was comment-enforced
   only — this test parses the actual SQL so editing one without the other
   fails CI instead of silently drifting (flagged in PR #235 review). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINT_PRICING } from '../print-pricing';

const MIGRATION = join(
  __dirname,
  '../../../supabase/migrations/20260807120000_print_pricing_config.sql',
);

describe('print_pricing_config migration seed', () => {
  it('matches DEFAULT_PRINT_PRICING exactly', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const insert = sql.match(/insert into print_pricing_config[\s\S]*?values\s*\(([\s\S]*?)\);/i);
    expect(insert, 'seed insert statement not found').not.toBeNull();
    const values = insert![1]
      .split(',')
      .map((v) => Number(v.trim()));
    expect(values).toHaveLength(11);

    const d = DEFAULT_PRINT_PRICING;
    expect(values).toEqual([
      d.baseEur['30x40'], d.baseEur['50x70'], d.baseEur['70x100'],
      d.frameEur['30x40'], d.frameEur['50x70'], d.frameEur['70x100'],
      d.mountEur['30x40'], d.mountEur['50x70'], d.mountEur['70x100'],
      d.eurToPln, d.eurToGbp,
    ]);
  });
});
