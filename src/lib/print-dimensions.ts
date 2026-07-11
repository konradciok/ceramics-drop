/**
 * Pure validation core for sync-prodigi-skus: compares what the Prodigi
 * `/products/{sku}` endpoint reports for EVERY variant against the per-variant
 * catalogue contract (`PRODIGI_SKU_MAP`).
 *
 * Pure — no fetch, no DB. Importable by the operator script and unit tests.
 *
 * Dimension authority: `product_variants.print_area_*_px` / `PRODIGI_SKU_MAP`.
 * `pod_variants` is a SKU cache and is NON-authoritative on disagreement.
 *
 * NOTE on per-variant correlation: `ProdigiProductResponse.product.variants[i]`
 * carries only `printAreaSizes` — no attribute id. So a variant cannot be
 * reliably correlated to a specific `variant_key` from the type alone. This
 * module therefore reports variants POSITIONALLY (by index), detects intra-SKU
 * disagreement, and flags a contract mismatch only when a variant's dims match
 * NONE of the distinct dims the contract assigns to that SKU. Exact
 * attribute→variant correlation needs a live response to confirm attribute
 * names. Surface, don't paper over.
 */
import type { ProdigiProductResponse } from '../server/prodigi/types';
import { PRODIGI_SKU_MAP } from './print-cart';

type Contract = Record<string, { sku: string; printAreaPx: { w: number; h: number } }>;

export interface VariantDim {
  /** Positional index in product.variants. NOT a stable attribute id. */
  index: number;
  w: number;
  h: number;
}

export interface ContractMismatch {
  variantIndex: number;
  prodigi: { w: number; h: number };
  /** The distinct dims the contract allows for this SKU. */
  contractDims: { w: number; h: number }[];
}

export interface ProdigiDimensionReport {
  sku: string;
  /** One entry per variant in product.variants (positional). */
  variants: VariantDim[];
  /** True when not all variants share identical dims. */
  intraSkuDisagreement: boolean;
  /** Distinct printAreaPx the contract assigns to this SKU's variant_keys. */
  contractDims: { w: number; h: number }[];
  /** Variants whose dims match none of contractDims. */
  contractMismatches: ContractMismatch[];
  /** True when the SKU is unknown to the contract (no variant_key maps to it). */
  unknownSku: boolean;
  /** Convenience: any reason the operator should be alerted. */
  hasProblem: boolean;
}

const sameDim = (a: { w: number; h: number }, b: { w: number; h: number }) =>
  a.w === b.w && a.h === b.h;

const distinctDims = (dims: { w: number; h: number }[]): { w: number; h: number }[] =>
  dims.filter((d, i, arr) => arr.findIndex((x) => sameDim(x, d)) === i);

/**
 * Validate every variant's print-area dimensions for a single Prodigi product
 * against the per-variant catalogue contract.
 */
export function validateProdigiDimensions(
  product: ProdigiProductResponse,
  contract: Contract = PRODIGI_SKU_MAP,
): ProdigiDimensionReport {
  const sku = product.product?.sku ?? '';
  const rawVariants = product.product?.variants ?? [];

  const variants: VariantDim[] = rawVariants.map((v, index) => ({
    index,
    w: v.printAreaSizes?.default?.horizontalResolution ?? 0,
    h: v.printAreaSizes?.default?.verticalResolution ?? 0,
  }));

  // Distinct dims the contract assigns to ANY variant_key that resolves to this SKU.
  const contractDims = distinctDims(
    Object.values(contract)
      .filter((entry) => entry.sku === sku)
      .map((entry) => entry.printAreaPx),
  );

  const unknownSku = contractDims.length === 0;

  const intraSkuDisagreement =
    variants.length > 1 && variants.some((v, _i, arr) => !sameDim(v, arr[0]));

  // A variant is a mismatch only if it matches NONE of the contract's known
  // dims for this SKU. (When variants disagree positionally we still can't pin
  // a variant to a variant_key, so we only flag genuinely unknown dims.)
  const contractMismatches: ContractMismatch[] = unknownSku
    ? []
    : variants
        .filter((v) => !contractDims.some((c) => sameDim(c, v)))
        .map((v) => ({ variantIndex: v.index, prodigi: { w: v.w, h: v.h }, contractDims }));

  const hasProblem = intraSkuDisagreement || contractMismatches.length > 0 || unknownSku;

  return { sku, variants, intraSkuDisagreement, contractDims, contractMismatches, unknownSku, hasProblem };
}
