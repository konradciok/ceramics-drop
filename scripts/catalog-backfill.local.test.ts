import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { backfillCatalog } from '../src/lib/catalog/repository';
import { buildCatalogSeed } from '../src/lib/catalog/seed';

const localUrl = process.env.LOCAL_SUPABASE_URL;
const localServiceRoleKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const describeLocal = localUrl && localServiceRoleKey ? describe : describe.skip;

function requireLocalUrl(raw: string): void {
  const hostname = new URL(raw).hostname;
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new Error(`LOCAL_SUPABASE_URL must be loopback-only, got ${hostname}`);
  }
}

function assertQuery(label: string, result: { error: { message: string } | null }): void {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

/**
 * Fresh-schema rehearsal of the real `backfill_catalog` RPC with the
 * ceramics-only seed (fine-art prints left the registry with the print shop,
 * 2026-11). Runs in the DB workflow against a local Supabase stack.
 */
describeLocal('fresh local catalog backfill (ceramics)', () => {
  const seed = buildCatalogSeed();
  const seededIds = seed.products.map(({ id }) => id);
  let supabase: SupabaseClient;

  beforeAll(async () => {
    requireLocalUrl(localUrl!);
    supabase = createClient(localUrl!, localServiceRoleKey!, {
      auth: { persistSession: false },
    });
    const empty = await supabase.from('products').select('id').limit(1);
    assertQuery('fresh-schema precondition', empty);
    if ((empty.data ?? []).length !== 0) {
      throw new Error('fresh-schema precondition: products must be empty; run supabase db reset');
    }
  });

  afterAll(async () => {
    if (!supabase) return;
    const audit = await supabase.from('catalog_audit_log').delete().in('product_id', seededIds);
    assertQuery('cleanup audit', audit);
    const products = await supabase.from('products').delete().in('id', seededIds);
    assertQuery('cleanup products', products);
  });

  it('seeds every ceramic, reruns idempotently, and rolls back an invalid rerun atomically', async () => {
    expect(seed.products.every(({ type }) => type === 'ceramic')).toBe(true);
    await expect(backfillCatalog(supabase)).resolves.toEqual({ skippedCmsOwnedIds: [] });

    const backfilled = await supabase.from('products').select('id').in('id', seededIds);
    assertQuery('read backfilled products', backfilled);
    expect((backfilled.data ?? []).map(({ id }) => id).sort()).toEqual([...seededIds].sort());

    await expect(backfillCatalog(supabase)).resolves.toEqual({ skippedCmsOwnedIds: [] });

    const ceramic = await supabase.from('products').select('id,status').eq('id', 'k01').single();
    assertQuery('read rerun ceramic', ceramic);
    expect(ceramic.data).toEqual({ id: 'k01', status: 'active' });
    const ceramicVariants = await supabase
      .from('product_variants')
      .select('variant_key,active')
      .eq('product_id', 'k01');
    assertQuery('read rerun ceramic variants', ceramicVariants);
    expect(ceramicVariants.data).toEqual([{ variant_key: 'default', active: true }]);

    const duplicateVariantSeed = [...seed.variants, seed.variants[0]];
    const failedAtomicRerun = await supabase.rpc('backfill_catalog', {
      p_products: seed.products,
      p_variants: duplicateVariantSeed,
      p_media: seed.media,
    });
    expect(failedAtomicRerun.error?.message).toMatch(/duplicate key|unique constraint/i);

    const afterFailedVariants = await supabase
      .from('product_variants')
      .select('variant_key,active')
      .eq('product_id', 'k01');
    assertQuery('read variants after failed atomic rerun', afterFailedVariants);
    expect(afterFailedVariants.data).toEqual([{ variant_key: 'default', active: true }]);
  }, 30_000);
});
