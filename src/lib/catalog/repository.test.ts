import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  backfillCatalog,
  updateProductStatus,
  listCatalogRows,
  readCeramicProducts,
  readPrintDesigns,
  readProductRow,
  updateProductMeta,
} from './repository';
import type { ProductSeedRow } from './types';

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

const PRINT_DRAFT = {
  id: 'fap01',
  type: 'print',
  category_slug: 'fine-art-prints',
  status: 'draft',
  published_at: null,
};

function supabaseForStatus(data: unknown, error: { message: string } | null = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { supabase: { rpc } as unknown as SupabaseClient, rpc };
}

describe('updateProductStatus guarded RPC', () => {
  it('maps an incomplete print response to PrintAssetsIncompleteError', async () => {
    const { supabase } = supabaseForStatus({
      ok: false,
      error: 'print_assets_incomplete',
      missing: ['50x70_unframed', '70x100_framed_black'],
    });

    await expect(
      updateProductStatus(supabase, 'fap01', 'active', 'ops@studio.pl'),
    ).rejects.toMatchObject({
      message: 'print_assets_incomplete',
      missing: ['50x70_unframed', '70x100_framed_black'],
    });
  });

  it('returns the atomically updated product and passes the actor', async () => {
    const product = {
      ...PRINT_DRAFT,
      status: 'active',
      published_at: '2026-07-17T12:00:00Z',
    };
    const { supabase, rpc } = supabaseForStatus({ ok: true, product });

    await expect(updateProductStatus(supabase, 'fap01', 'active', 'ops@studio.pl')).resolves.toBe(
      product,
    );
    expect(rpc).toHaveBeenCalledWith('update_product_status_guarded', {
      p_product_id: 'fap01',
      p_status: 'active',
      p_actor_email: 'ops@studio.pl',
    });
  });

  it('uses the same RPC for non-active and ceramic transitions', async () => {
    const ceramic = { ...PRINT_DRAFT, id: 'k01', type: 'ceramic', status: 'hidden' };
    const { supabase, rpc } = supabaseForStatus({ ok: true, product: ceramic });

    await updateProductStatus(supabase, 'k01', 'hidden', null);
    expect(rpc).toHaveBeenCalledWith('update_product_status_guarded', {
      p_product_id: 'k01',
      p_status: 'hidden',
      p_actor_email: null,
    });
  });

  it('normalises the RPC product-not-found error for the route mapper', async () => {
    const { supabase } = supabaseForStatus(null, { message: 'product_not_found' });

    await expect(updateProductStatus(supabase, 'missing', 'active', null)).rejects.toThrow(
      'product_not_found',
    );
  });

  it('fails closed on an empty RPC response', async () => {
    const { supabase } = supabaseForStatus(null);

    await expect(updateProductStatus(supabase, 'fap01', 'active', null)).rejects.toThrow(
      'empty RPC response',
    );
  });
});

function supabaseForBackfill(error: { message: string } | null = null) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error });
  return { supabase: { rpc } as unknown as SupabaseClient, rpc };
}

describe('backfillCatalog print publication safety', () => {
  it('sends the complete structural seed through one atomic database RPC', async () => {
    const { supabase, rpc } = supabaseForBackfill();

    await backfillCatalog(supabase);

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('backfill_catalog', {
      p_products: expect.arrayContaining([
        expect.objectContaining({ id: 'fap001', type: 'print', status: 'active' }),
        expect.objectContaining({ id: 'fap029', type: 'print', status: 'archived' }),
        expect.objectContaining({ id: 'k01', type: 'ceramic', status: 'active' }),
      ]),
      p_variants: expect.arrayContaining([
        expect.objectContaining({ product_id: 'fap001' }),
        expect.objectContaining({ product_id: 'k01', variant_key: 'default' }),
      ]),
      p_media: expect.arrayContaining([
        expect.objectContaining({ product_id: 'fap001' }),
        expect.objectContaining({ product_id: 'k01' }),
      ]),
    });
  });

  it('surfaces an atomic backfill RPC failure', async () => {
    const { supabase } = supabaseForBackfill({ message: 'duplicate key' });

    await expect(backfillCatalog(supabase)).rejects.toThrow(
      'atomic catalog backfill: duplicate key',
    );
  });
});

/* ============================================================
   Fail-closed read guard (M-4) — one test per reader path.

   Two-tier behavior per the Dispatch B ruling: customer/storefront readers
   (readCeramicProducts, readPrintDesigns) SKIP an invalid ceramic row;
   admin-only readers (listCatalogRows, readProductRow, updateProductMeta)
   validate + report but keep the row — see read-schemas.ts's parseProductRow
   doc comment for why (catalog-list.ts's cascading registry-fallback would
   otherwise hide the whole admin list, or swap in stale registry seed data,
   on a single bad row).
   ============================================================ */

function ceramicRow(over: Partial<ProductSeedRow> = {}): ProductSeedRow {
  return {
    id: 'k01',
    type: 'ceramic',
    category_slug: 'kubki',
    num: '01',
    slug: null,
    price_pln: 120,
    price_eur: null,
    price_gbp: null,
    sale_price_pln: null,
    sale_price_eur: null,
    sale_price_gbp: null,
    measure: '9 cm',
    status: 'active',
    seo_title: null,
    seo_description: null,
    drop_id: 'drop-1',
    note_index: 1,
    ...over,
  };
}

function printRow(over: Partial<ProductSeedRow> = {}): ProductSeedRow {
  return {
    ...ceramicRow(),
    id: 'fap01',
    type: 'print',
    category_slug: 'fine-art-prints',
    price_pln: null,
    ...over,
  };
}

/** A thenable chain where every builder returns the chain; awaits resolve to
 *  `result`. `.maybeSingle()` resolves individually. Mirrors the idiom in
 *  src/server/print-assets/repository.test.ts / process-job.test.ts. */
function makeChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn),
    finally: (fn: () => void) => Promise.resolve(result).finally(fn),
  };
  for (const m of ['eq', 'select', 'order', 'in', 'update', 'insert', 'delete', 'upsert', 'abortSignal']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  return chain;
}

describe('fail-closed read guard — per-reader behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('listCatalogRows (admin) keeps a NULL-priced ceramic row in the array, reporting it once', async () => {
    const good = ceramicRow({ id: 'k01', price_pln: 120 });
    const bad = ceramicRow({ id: 'k02', price_pln: null });
    const from = vi.fn((table: string) => {
      if (table === 'products') return makeChain({ data: [good, bad], error: null });
      if (table === 'product_variants') return makeChain({ data: [], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    const supabase = { from } as unknown as SupabaseClient;

    const result = await listCatalogRows(supabase);

    // Report+keep: the bad row stays in the array (admin's own diagnostic
    // list must not go blind to the row it exists to find and fix).
    expect(result.products.map((r) => r.id)).toEqual(['k01', 'k02']);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'catalog row failed validation',
      expect.objectContaining({ extra: expect.objectContaining({ productId: 'k02' }) }),
    );
  });

  it('readCeramicProducts (storefront) excludes a 0-priced ceramic row from Product[], reporting it', async () => {
    const good = ceramicRow({ id: 'k01', price_pln: 120 });
    const bad = ceramicRow({ id: 'k02', price_pln: 0 });
    const from = vi.fn((table: string) => {
      if (table === 'products') return makeChain({ data: [good, bad], error: null });
      if (table === 'product_media') return makeChain({ data: [], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    const supabase = { from } as unknown as SupabaseClient;

    const products = await readCeramicProducts(supabase);

    // Skip: a piece can never render/sell at 0 zł — this is the actual M-4 fix.
    expect(products.map((p) => p.id)).toEqual(['k01']);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('readPrintDesigns (storefront) passes a NULL-priced print row through untouched', async () => {
    const design = printRow({ id: 'fap01', price_pln: null, status: 'active' });
    const from = vi.fn((table: string) => {
      if (table === 'products') return makeChain({ data: [design], error: null });
      if (table === 'product_variants') return makeChain({ data: [], error: null });
      if (table === 'product_media') return makeChain({ data: [], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    const supabase = { from } as unknown as SupabaseClient;

    const designs = await readPrintDesigns(supabase);

    expect(designs.map((d) => d.id)).toEqual(['fap01']);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('readPrintDesigns (storefront) defensively skips+reports a bad-priced ceramic-typed row if one ever appeared', async () => {
    // Defensive/synthetic: the `.eq('type','print')` query means a ceramic
    // row should never actually reach this reader in practice, but the
    // shared parseProductRows guard must still catch it if it somehow did —
    // proving "a reader the fix forgot" cannot bypass validation.
    const rogueCeramic = ceramicRow({ id: 'k99', price_pln: null });
    const design = printRow({ id: 'fap01', price_pln: null, status: 'active' });
    const from = vi.fn((table: string) => {
      if (table === 'products') return makeChain({ data: [design, rogueCeramic], error: null });
      if (table === 'product_variants') return makeChain({ data: [], error: null });
      if (table === 'product_media') return makeChain({ data: [], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    const supabase = { from } as unknown as SupabaseClient;

    const designs = await readPrintDesigns(supabase);

    expect(designs.map((d) => d.id)).toEqual(['fap01']); // rogue ceramic never surfaces
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('readProductRow (admin editor) validates + reports a bad ceramic row but still returns it', async () => {
    const bad = ceramicRow({ id: 'k02', price_pln: 0 });
    const from = vi.fn((table: string) => {
      if (table === 'products') return makeChain({ data: bad, error: null });
      if (table === 'product_variants') return makeChain({ data: [], error: null });
      if (table === 'product_media') return makeChain({ data: [], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    const supabase = { from } as unknown as SupabaseClient;

    const result = await readProductRow(supabase, 'k02');

    // Report+keep: the editor's whole purpose is inspecting/fixing this exact
    // row, so it must not fall back to a stale registry seed instead.
    expect(result?.product.id).toBe('k02');
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('updateProductMeta (admin write) validates + reports a bad-priced write result but still returns it', async () => {
    const before = ceramicRow({ id: 'k02', price_pln: 120 });
    const after = ceramicRow({ id: 'k02', price_pln: 0 });
    const from = vi.fn();
    from
      .mockImplementationOnce(() => makeChain({ data: before, error: null })) // load "before"
      .mockImplementationOnce(() => makeChain({ data: after, error: null })) // update + select
      .mockImplementationOnce(() => makeChain({ data: null, error: null })); // audit insert
    const supabase = { from } as unknown as SupabaseClient;

    const result = await updateProductMeta(supabase, 'k02', {}, 'ops@studio.pl');

    expect(result.id).toBe('k02');
    expect(result.price_pln).toBe(0); // write result surfaced as-is, not withheld
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
});
