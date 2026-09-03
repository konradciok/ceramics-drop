import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import {
  getProducts,
  getPublicProducts,
  getProductById,
  getProductsByCategory,
  isProductPublic,
  registryProducts,
} from '../products';
import { getPrintById, getPrintDesigns, registryPrintDesigns } from '../prints';
import { buildCatalogSeed } from './seed';
import { mapCeramicProducts, mapPrintDesigns, sortCeramicProductRows } from './mappers';
import { catalogSource } from './source';
import { resetLastKnownGoodForTests } from './last-known-good';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

/**
 * Accessor-level parity gate for the Stage 3b flip: repository ordering and the
 * CATALOG_SOURCE flag must match registry semantics before the storefront flips.
 */
describe('catalog read path ↔ registry parity', () => {
  const seed = buildCatalogSeed();

  it('recovers CATEGORY_ORDER from alphabetical DB row order', () => {
    const ceramics = seed.products.filter((p) => p.type === 'ceramic');
    const dbOrder = [...ceramics].sort((a, b) => {
      const byCat = a.category_slug.localeCompare(b.category_slug);
      return byCat !== 0 ? byCat : a.num.localeCompare(b.num, undefined, { numeric: true });
    });
    expect(dbOrder[0]?.id).not.toBe(registryProducts()[0]?.id);
    expect(mapCeramicProducts(sortCeramicProductRows(dbOrder), seed.media)).toEqual(registryProducts());
  });
});

describe('catalogSource', () => {
  const original = process.env.CATALOG_SOURCE;
  afterEach(() => {
    if (original === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = original;
  });

  it("defaults to 'code' when unset or not exactly 'db'", () => {
    delete process.env.CATALOG_SOURCE;
    expect(catalogSource()).toBe('code');
    process.env.CATALOG_SOURCE = 'registry';
    expect(catalogSource()).toBe('code');
  });

  it("returns 'db' only for the exact string 'db'", () => {
    process.env.CATALOG_SOURCE = 'db';
    expect(catalogSource()).toBe('db');
  });
});

/* ============================================================
   End-to-end flip gate: drive the PUBLIC async accessors with
   CATALOG_SOURCE='db', proving the async wrappers + the dynamic DB read path
   reproduce the registry exactly. The DB load module is mocked to return the
   mapper output for the backfill seed (i.e. what a backfilled Supabase would
   yield), so this needs no live database — the same guard the mapper parity
   test gives, but exercised THROUGH getProducts()/getPrintDesigns() rather than
   the mappers alone.
   ============================================================ */
vi.mock('./load', () => ({
  loadCeramicProductsFromDb: vi.fn(),
  loadPrintDesignsFromDb: vi.fn(),
}));
import { loadCeramicProductsFromDb, loadPrintDesignsFromDb } from './load';

describe('async accessors under CATALOG_SOURCE=db', () => {
  const seed = buildCatalogSeed();
  // DB-derived shapes = exactly what the repository readers reconstruct from a
  // backfilled catalogue (mapper output on the seed rows).
  const dbCeramics = mapCeramicProducts(sortCeramicProductRows(seed.products), seed.media);
  const dbPrints = mapPrintDesigns(seed.products, seed.variants, seed.media);
  const original = process.env.CATALOG_SOURCE;

  beforeEach(() => {
    // Each test starts as a "cold" isolate — no prior successful DB read —
    // so last-known-good state never leaks across tests in this file.
    resetLastKnownGoodForTests();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = original;
    vi.clearAllMocks();
  });

  it('getProducts()/byId/byCategory deep-equal the registry via the DB path', async () => {
    process.env.CATALOG_SOURCE = 'db';
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue(dbCeramics);

    expect(await getProducts()).toEqual(registryProducts());
    expect(await getProductById('k01')).toEqual(registryProducts().find((p) => p.id === 'k01'));
    expect(await getProductById('nope')).toBeUndefined();
    expect((await getProductsByCategory('kubki')).map((p) => p.id)).toEqual(
      registryProducts().filter((p) => p.category === 'kubki').map((p) => p.id),
    );
    // The DB branch was actually taken (not the registry short-circuit).
    expect(loadCeramicProductsFromDb).toHaveBeenCalled();
  });

  it('withdraws a non-active ceramic from public surfaces but still resolves it by id', async () => {
    process.env.CATALOG_SOURCE = 'db';
    // Same catalogue as the registry, but k01 is flipped to draft in the DB.
    const withDraft = dbCeramics.map((p) => (p.id === 'k01' ? { ...p, status: 'draft' as const } : p));
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue(withDraft);

    const publicIds = new Set((await getPublicProducts()).map((p) => p.id));
    expect(publicIds.has('k01')).toBe(false); // draft → withdrawn from /sklep, sitemap, feeds
    expect((await getProductsByCategory('kubki')).some((p) => p.id === 'k01')).toBe(false);
    // Still resolvable by id (admin / PDP guard decides visibility itself).
    expect((await getProductById('k01'))?.status).toBe('draft');
    // Every other piece stays public.
    expect(publicIds.has('k04')).toBe(true);
  });

  describe('DB failure — last-known-good / fail-closed public projection (SEO-003)', () => {
    it('warm isolate, DB throws: serves last-known-good — draft stays withdrawn, sold/showroom stays public', async () => {
      process.env.CATALOG_SOURCE = 'db';
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Warm the isolate: this "last successful" DB read has k01 as draft and
      // k04 already sold (sold pieces are still public, just not purchasable).
      const warmed = dbCeramics.map((p) => {
        if (p.id === 'k01') return { ...p, status: 'draft' as const };
        if (p.id === 'k04') return { ...p, sold: true };
        return p;
      });
      vi.mocked(loadCeramicProductsFromDb).mockResolvedValue(warmed);
      await getProducts(); // records last-known-good

      vi.mocked(loadCeramicProductsFromDb).mockRejectedValue(new Error('supabase down'));
      const publicIds = new Set((await getPublicProducts()).map((p) => p.id));
      expect(publicIds.has('k01')).toBe(false); // draft in the last-known-good stays withdrawn
      expect(publicIds.has('k04')).toBe(true); // sold piece stays public (not purchasable elsewhere)
      expect((await getProductById('k01'))?.status).toBe('draft');
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('warm isolate, DB times out: serves last-known-good on a timeout, not just a thrown error', async () => {
      process.env.CATALOG_SOURCE = 'db';
      vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.mocked(loadCeramicProductsFromDb).mockResolvedValue(dbCeramics);
      await getProducts(); // records last-known-good

      // AbortSignal.timeout() rejects with a DOMException named 'TimeoutError'.
      vi.mocked(loadCeramicProductsFromDb).mockRejectedValue(
        new DOMException('The operation timed out.', 'TimeoutError'),
      );
      expect(await getProducts()).toEqual(dbCeramics);
    });

    it('cold isolate, DB throws: fails closed — nothing public, PDP guard 404s', async () => {
      process.env.CATALOG_SOURCE = 'db';
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(loadCeramicProductsFromDb).mockRejectedValue(new Error('supabase down'));

      expect(await getPublicProducts()).toEqual([]);
      expect(await getProductsByCategory('kubki')).toEqual([]);
      const k01 = await getProductById('k01');
      expect(k01).toBeDefined();
      expect(isProductPublic(k01!)).toBe(false); // the real PDP route 404s on this
    });

    it('tags the Sentry report with the fallback tier actually served', async () => {
      process.env.CATALOG_SOURCE = 'db';
      vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.mocked(loadCeramicProductsFromDb).mockRejectedValue(new Error('supabase down'));
      await getProducts(); // cold isolate → cold-fail-closed
      expect(Sentry.captureException).toHaveBeenLastCalledWith(
        expect.any(Error),
        expect.objectContaining({ extra: { fallbackTier: 'cold-fail-closed' } }),
      );

      vi.mocked(loadCeramicProductsFromDb).mockResolvedValueOnce(dbCeramics);
      await getProducts(); // warms the isolate
      vi.mocked(loadCeramicProductsFromDb).mockRejectedValue(new Error('supabase down again'));
      await getProducts(); // warm isolate → last-known-good
      expect(Sentry.captureException).toHaveBeenLastCalledWith(
        expect.any(Error),
        expect.objectContaining({ extra: { fallbackTier: 'last-known-good' } }),
      );
    });
  });

  it('getPrintDesigns()/getPrintById() deep-equal the registry via the DB path', async () => {
    process.env.CATALOG_SOURCE = 'db';
    vi.mocked(loadPrintDesignsFromDb).mockResolvedValue(dbPrints);

    expect(dbPrints.filter((design) => design.published).map((design) => design.id)).toEqual(
      registryPrintDesigns().map((design) => design.id),
    );

    // getPrintDesigns filters to published, in num order — must equal the registry
    // helper modulo `mockups` and `editorialGallery`, which are code-bundle truth
    // the DB path never carries (PrintProductScreen re-merges both from the code
    // registry).
    expect(await getPrintDesigns()).toEqual(
      registryPrintDesigns().map((d) => {
        const design = { ...d };
        delete design.mockups;
        delete design.editorialGallery;
        return design;
      }),
    );
    // getPrintById resolves unpublished designs too (checkout needs to reject
    // hidden vs unknown). Synthesize a second unpublished row so this behavior
    // does not depend only on the two archived fixtures.
    const withDraft = dbPrints.map((d, i) => (i === 0 ? { ...d, published: false } : d));
    vi.mocked(loadPrintDesignsFromDb).mockResolvedValue(withDraft);
    expect((await getPrintById(withDraft[0].id))?.published).toBe(false);
    expect(await getPrintById('unknown')).toBeUndefined();
    expect(loadPrintDesignsFromDb).toHaveBeenCalled();
  });
});
