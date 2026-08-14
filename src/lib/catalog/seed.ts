/* ============================================================
   Catalog seed builder — code registry → DB rows
   ------------------------------------------------------------
   Pure, deterministic transform from the static registry
   (src/lib/products.ts + src/lib/prints.ts + pricing) into the
   `products` / `product_variants` / `product_media` row shapes.

   This is the SINGLE source of the backfill: `backfillCatalog()` upserts
   exactly these rows, and the parity test round-trips them back through the
   mappers to prove `DB == registry` before any storefront flip. No business
   rule is re-implemented here — print variant validity reuses the existing
   axis rules from `prints.ts` / `print-cart.ts`.
   ============================================================ */
import type { PrintDesign, PrintFrameColour, PrintVariantSelection } from '../types';
import { registryProducts } from '../products';
// Ungated on purpose: the backfill must keep seeding every structurally valid
// variant (incl. mount) while passe-partout is temporarily withdrawn from sale,
// so a run during the disabled window reproduces the existing DB exactly.
import { PRINT_DESIGNS_RAW as PRINT_DESIGNS } from '../prints';
import { PRICE_EUR, PRICE_GBP } from '../pricing';
import { assetPxFor, variantKey, PRODIGI_SKU_MAP } from '../print-cart';
import { DEFAULT_PRINT_PRICING, priceOfVariant, type PrintPricingConfig } from '../print-pricing';
import type { CatalogSeed } from './types';

/**
 * Enumerate every structurally-valid print variant for a design, in a stable
 * order: per size — the unframed variant, then each frame colour (no-mount, then
 * mount when the design offers it). Mirrors the axis rules encoded in
 * `isVariantAvailable` (prints.ts) without depending on `published`, so a draft
 * design still yields its variant rows (flagged inactive).
 */
export function enumeratePrintVariants(design: PrintDesign): PrintVariantSelection[] {
  const excluded = new Set(design.unavailable ?? []);
  const out: PrintVariantSelection[] = [];
  const add = (sel: PrintVariantSelection) => {
    // Structural exclusions (design.unavailable) are published-independent, so a
    // draft design still yields its variant rows minus the excluded keys —
    // matching the sellability rules in isVariantAvailable (prints.ts).
    if (!excluded.has(variantKey(sel))) out.push(sel);
  };
  for (const size of design.sizes) {
    add({ size, framed: false, mount: false, frameColour: 'none' });
    for (const frameColour of design.frameColours as PrintFrameColour[]) {
      add({ size, framed: true, mount: false, frameColour });
      if (design.mountAvailable) {
        add({ size, framed: true, mount: true, frameColour });
      }
    }
  }
  return out;
}

function ceramicRows(seed: CatalogSeed): void {
  for (const p of registryProducts()) {
    seed.products.push({
      id: p.id,
      type: 'ceramic',
      category_slug: p.category,
      num: p.num,
      slug: null,
      // PLN honours per-product overrides (product.price); EUR/GBP are the
      // per-category tables, exactly as priceOfCurrency() resolves them today.
      price_pln: p.price,
      price_eur: PRICE_EUR[p.category],
      price_gbp: PRICE_GBP[p.category],
      sale_price_pln: null,
      sale_price_eur: null,
      sale_price_gbp: null,
      measure: p.measure,
      status: 'active',
      seo_title: null,
      seo_description: null,
      drop_id: p.dropId,
      note_index: p.noteIndex,
    });

    // One default variant, 1/1 stock.
    seed.variants.push({
      product_id: p.id,
      variant_key: 'default',
      sku: null,
      axes: null,
      price_pln: null,
      price_eur: null,
      price_gbp: null,
      is_default: true,
      active: true,
      position: 0,
      track_inventory: true,
      stock_quantity: 1,
      allow_backorder: false,
      low_stock_threshold: null,
      // Ceramics have no print-area contract.
      print_area_width_px: null,
      print_area_height_px: null,
    });

    // Primary image + gallery (in registry order).
    seed.media.push({ product_id: p.id, url: p.image, alt: null, position: 0, is_primary: true });
    (p.gallery ?? []).forEach((url, i) => {
      seed.media.push({ product_id: p.id, url, alt: null, position: i + 1, is_primary: false });
    });
  }
}

function printRows(seed: CatalogSeed, pricing: PrintPricingConfig): void {
  for (const d of PRINT_DESIGNS) {
    seed.products.push({
      id: d.id,
      type: 'print',
      category_slug: 'fine-art-prints',
      num: d.num,
      slug: null,
      // Prints are priced per variant via print-pricing.ts; product-level price
      // stays null (dynamic) until a later stage migrates print pricing.
      price_pln: null,
      price_eur: null,
      price_gbp: null,
      sale_price_pln: null,
      sale_price_eur: null,
      sale_price_gbp: null,
      measure: '',
      status: d.published ? 'active' : 'draft',
      seo_title: null,
      seo_description: null,
      drop_id: null,
      note_index: d.noteIndex,
    });

    const sels = enumeratePrintVariants(d);
    // Default = the cheapest sellable variant (matches fromPriceOf semantics),
    // rather than the first enumerated one — robust even if `design.unavailable`
    // ever excludes the smallest unframed variant.
    const prices = sels.map((sel) => priceOfVariant(sel, 'pln', pricing));
    const defaultIdx = prices.reduce((best, p, i) => (p < prices[best] ? i : best), 0);
    sels.forEach((sel, i) => {
      const key = variantKey(sel);
      const mapped = PRODIGI_SKU_MAP[key];
      seed.variants.push({
        product_id: d.id,
        variant_key: key,
        sku: mapped?.sku ?? null,
        axes: sel,
        // Derived from the passed pricing config at seed time (major units;
        // defaults to DEFAULT_PRINT_PRICING). These shadow columns are read by
        // nobody — checkout prices via getPrintPricingConfig() — so after an
        // /admin/pricing edit they reflect the code default, not the live DB
        // config. The parity test pins them to the same default.
        price_pln: prices[i],
        price_eur: priceOfVariant(sel, 'eur', pricing),
        price_gbp: priceOfVariant(sel, 'gbp', pricing),
        is_default: i === defaultIdx,
        active: d.published,
        position: i,
        track_inventory: false, // POD — no held stock
        stock_quantity: 0,
        allow_backorder: true,
        low_stock_threshold: null,
        // Per-variant ASSET pixels at 300 DPI (assetPxFor: the render we upload,
        // not necessarily Prodigi's reported print area — black 30x40 framed
        // submits the shared 3600×4800 render, prodigi/decisions.md #6); the
        // publish_print_asset_revision RPC checks ready assets against these.
        // Absent key → null → RPC treats it as a dimension mismatch (fail-closed).
        print_area_width_px: mapped ? assetPxFor(mapped).w : null,
        print_area_height_px: mapped ? assetPxFor(mapped).h : null,
      });
    });

    seed.media.push({ product_id: d.id, url: d.image, alt: null, position: 0, is_primary: true });
    (d.gallery ?? []).forEach((url, i) => {
      seed.media.push({ product_id: d.id, url, alt: null, position: i + 1, is_primary: false });
    });
  }
}

/** Build the full catalog backfill payload from the static registry. */
export function buildCatalogSeed(pricing: PrintPricingConfig = DEFAULT_PRINT_PRICING): CatalogSeed {
  const seed: CatalogSeed = { products: [], variants: [], media: [] };
  ceramicRows(seed);
  printRows(seed, pricing);
  return seed;
}
