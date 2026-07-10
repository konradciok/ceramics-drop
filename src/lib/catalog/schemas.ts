/* ============================================================
   Catalog write schemas (Zod) — admin product editor
   ------------------------------------------------------------
   Server + client validation for the /api/admin/products write routes
   (Stage 4a). Kept narrow on purpose: only the fields that actually flow to
   the storefront in db mode are editable here.
     - price_pln  → Product.price (priceOfCurrency PLN). EUR/GBP stay per-category
       tables, so product-level EUR/GBP overrides are intentionally NOT editable
       yet (they would be silently ignored by the storefront).
     - sale price, category move, and slug-as-URL are deferred (Stage 4c / later);
       `slug` here is stored as an SEO/canonical hint only, not a routing key.
   ============================================================ */
import { z } from 'zod';
import type { ProductStatus } from './types';

/** The nine ceramic category slugs (fine-art-prints is edited via the print path). */
export const CERAMIC_CATEGORY = z.enum([
  'kubki',
  'wazony',
  'wazony-srednie',
  'wazony-duze',
  'talerzyki',
  'talerze-srednie',
  'talerze-duze',
  'duze-michy',
  'miski-falowane',
]);

/** Blank/whitespace form value → null (clears the column); absent → untouched. */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Optional, nullable, length-capped text (empty string clears it). */
const nullableText = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());

/** PATCH body for product metadata. All fields optional; unknown keys rejected. */
export const productUpdateSchema = z
  .object({
    num: z.string().trim().min(1).max(16).optional(),
    price_pln: z.number().int().nonnegative().max(1_000_000).optional(),
    measure: z.string().trim().max(200).optional(),
    seo_title: nullableText(160),
    seo_description: nullableText(320),
    // Lowercase kebab slug, or null/blank to clear. Stored as an SEO/canonical
    // hint only in 4a (URLs still resolve by id); pretty-slug routing + 301s are
    // Stage 4c. `preprocess` turns a blank field into null BEFORE the regex runs.
    slug: z.preprocess(
      blankToNull,
      z
        .string()
        .trim()
        .max(120)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug_format')
        .nullable()
        .optional(),
    ),
  })
  .strict();

export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

/** POST body for a publish-status transition. */
export const productStatusSchema = z
  .object({
    status: z.enum(['draft', 'active', 'hidden', 'archived']),
  })
  .strict();

export type ProductStatusInput = z.infer<typeof productStatusSchema>;

// Compile-time guard: the schema status union must stay in lockstep with the
// domain ProductStatus type.
const _statusCheck: ProductStatus = 'active' as ProductStatusInput['status'];
void _statusCheck;
