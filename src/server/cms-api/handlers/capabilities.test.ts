import { describe, expect, it } from 'vitest';
import { capabilitiesRoute } from './capabilities';
import type { HandlerContext } from '../router';

const ctx: HandlerContext = { actorEmail: 'anna@anna-ciok.studio', requestId: 'req_test', supabase: {} as never };

describe('capabilitiesRoute', () => {
  it('lists exactly the 9 ceramic categories and print axes', async () => {
    const res = await capabilitiesRoute.handler(new Request('https://x.test/v1/capabilities'), {} as CloudflareEnv, {}, ctx);
    const body = await res.json();
    expect(body.ceramicCategories).toHaveLength(9);
    expect(body.printSizes).toEqual(['30x40', '50x70', '70x100']);
    expect(body.currencies).toEqual(['pln', 'eur', 'gbp']);
    expect(body.productStatuses).toEqual(['draft', 'active', 'hidden', 'archived']);
  });
});
