import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { backfillCatalog, updateProductStatus } from '../src/lib/catalog/repository';
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

describeLocal('fresh local catalog backfill publication gate', () => {
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

  it('keeps every print non-active, then activates one only after valid fixtures exist', async () => {
    await backfillCatalog(supabase);

    const backfilled = await supabase
      .from('products')
      .select('id,status')
      .eq('type', 'print')
      .order('id');
    assertQuery('read backfilled prints', backfilled);
    expect(backfilled.data).toHaveLength(41);
    expect(backfilled.data?.filter(({ status }) => status === 'active')).toEqual([]);
    expect(backfilled.data?.filter(({ status }) => status === 'draft')).toHaveLength(39);
    expect(backfilled.data?.filter(({ status }) => status === 'archived')).toHaveLength(2);

    const productId = 'fap001';
    const variants = await supabase
      .from('product_variants')
      .select('variant_key,print_area_width_px,print_area_height_px')
      .eq('product_id', productId)
      .eq('active', true)
      .order('variant_key');
    assertQuery('read active variants', variants);
    expect(variants.data?.length).toBeGreaterThan(0);

    const assets = (variants.data ?? []).map((variant, index) => {
      if (!variant.print_area_width_px || !variant.print_area_height_px) {
        throw new Error(`variant ${variant.variant_key} has no print-area dimensions`);
      }
      return {
        id: randomUUID(),
        product_id: productId,
        revision: 'local-readiness-r1',
        profile_key: `${variant.print_area_width_px}x${variant.print_area_height_px}`,
        r2_key: `local-readiness/${productId}/${index}.jpg`,
        sha256: `local-readiness-${index}`,
        content_type: 'image/jpeg',
        width_px: variant.print_area_width_px,
        height_px: variant.print_area_height_px,
        byte_size: 1,
        status: 'ready',
      };
    });
    const insertedAssets = await supabase.from('print_fulfilment_assets').insert(assets);
    assertQuery('insert ready assets', insertedAssets);
    const assignments = (variants.data ?? []).map((variant, index) => ({
      product_id: productId,
      variant_key: variant.variant_key,
      asset_id: assets[index].id,
    }));
    const insertedAssignments = await supabase
      .from('print_variant_asset_assignments')
      .insert(assignments);
    assertQuery('insert assignments', insertedAssignments);

    await expect(
      updateProductStatus(supabase, productId, 'active', 'local-readiness@test.invalid'),
    ).resolves.toMatchObject({ id: productId, status: 'active' });

    const activated = await supabase
      .from('products')
      .select('id,status')
      .eq('type', 'print')
      .eq('status', 'active');
    assertQuery('read activated prints', activated);
    expect(activated.data).toEqual([{ id: productId, status: 'active' }]);
  }, 30_000);
});
