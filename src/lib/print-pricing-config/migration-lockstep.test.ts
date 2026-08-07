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
  it('matches DEFAULT_PRINT_PRICING exactly (by column name, order-independent)', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const insert = sql.match(
      /insert into print_pricing_config\s*\(([\s\S]*?)\)\s*values\s*\(([\s\S]*?)\);/i,
    );
    expect(insert, 'seed insert statement not found').not.toBeNull();
    const strip = (s: string) => s.replace(/--[^\n]*/g, '');
    const columns = strip(insert![1]).split(',').map((c) => c.trim()).filter(Boolean);
    const values = strip(insert![2]).split(',').map((v) => Number(v.trim()));
    expect(columns).toHaveLength(values.length);
    const seeded = Object.fromEntries(columns.map((c, i) => [c, values[i]]));

    const d = DEFAULT_PRINT_PRICING;
    expect(seeded).toEqual({
      base_30x40_eur: d.baseEur['30x40'], base_50x70_eur: d.baseEur['50x70'], base_70x100_eur: d.baseEur['70x100'],
      frame_30x40_eur: d.frameEur['30x40'], frame_50x70_eur: d.frameEur['50x70'], frame_70x100_eur: d.frameEur['70x100'],
      mount_30x40_eur: d.mountEur['30x40'], mount_50x70_eur: d.mountEur['50x70'], mount_70x100_eur: d.mountEur['70x100'],
      eur_to_pln: d.eurToPln, eur_to_gbp: d.eurToGbp,
    });
  });
});
