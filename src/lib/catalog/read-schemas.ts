/* ============================================================
   Catalog read schemas (Zod) — fail-closed row guard (M-4)
   ------------------------------------------------------------
   Sibling to schemas.ts (which validates the ADMIN WRITE path). This module
   validates rows coming OUT of the `products` table before they reach any
   caller, so a NULL/0-priced ceramic row can never render or sell at 0 zł —
   even if it exists in the DB (a row written before Dispatch A's CHECK
   constraint existed, or a future service-role write path that bypasses
   application code entirely). Defense-in-depth: the DB constraint stops new
   bad writes, this module stops a bad row that already exists from doing
   damage on read.
   ============================================================ */
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import type { ProductSeedRow } from './types';

/**
 * Row-shape guard: only `type` and `price_pln` are constrained (the fields
 * this guard actually cares about); every other column passes through
 * unvalidated via `.passthrough()` so this schema doesn't have to be kept in
 * lockstep with every column of `ProductSeedRow` — that duplication would be
 * its own maintenance hazard. `price_pln` must be a positive integer, but
 * ONLY for ceramic rows: print variant prices come from the separate global
 * print-pricing config (see AGENTS.md § Pricing & Shipping), so
 * `products.price_pln` is intentionally unconstrained for `type: 'print'`.
 */
const productRowGuardSchema = z
  .object({
    id: z.string(),
    type: z.enum(['ceramic', 'print']),
    price_pln: z.number().nullable(),
  })
  .passthrough()
  .superRefine((row, ctx) => {
    if (row.type !== 'ceramic') return;
    if (!(typeof row.price_pln === 'number' && Number.isInteger(row.price_pln) && row.price_pln > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['price_pln'],
        message: 'ceramic price_pln must be a positive integer',
      });
    }
  });

/** `row.id`, best-effort — the row failed validation so its shape isn't guaranteed. */
function rowId(row: unknown): string {
  return typeof row === 'object' && row !== null && 'id' in row && typeof (row as { id: unknown }).id === 'string'
    ? (row as { id: string }).id
    : 'unknown';
}

/**
 * Validate one raw `products` row. Reports (console.error + Sentry) INSIDE
 * this function whenever validation fails, regardless of what the caller
 * does with the `ok: false` result — a bad row must reach Sentry from every
 * boundary that reads it, per the M-4 remediation.
 *
 * Two-tier behavior lives in the CALLERS (repository.ts), not here, because
 * the right response to a bad row depends on the audience:
 *
 * - Customer/storefront readers (`readCeramicProducts`, `readPrintDesigns`)
 *   use the `ok` flag to SKIP the row — a piece can never render/sell at
 *   0 zł. This is the actual M-4 fix.
 * - Admin-only readers (`listCatalogRows`, `readProductRow`,
 *   `updateProductMeta`) call this purely for its reporting side effect and
 *   keep the row regardless of `ok`. Tracing the actual callers in
 *   `src/lib/admin/catalog-list.ts` showed why a literal "skip everywhere"
 *   reading of the plan text is wrong for these three: `listProducts()`
 *   (catalog-list.ts) treats `dbRows.products.length >= registry.products.length`
 *   as its completeness gate and falls back to the ENTIRE code-registry
 *   snapshot — every product, not just the bad one — the moment the DB count
 *   looks short, so a silently dropped row would hide every admin-set
 *   status/note/price override across the whole list. And
 *   `getProductEditorState()` (same file) already falls back to the stale
 *   registry seed when its row is null, so a dropped row there would swap in
 *   different slug/SEO/notes than what is actually live — actively
 *   misleading on the one screen whose purpose is inspecting and fixing
 *   exactly this kind of bad row. Reporting-without-hiding keeps the bad row
 *   visible in Sentry AND visible to the admin trying to fix it.
 */
export function parseProductRow(
  row: unknown,
): { ok: true; row: ProductSeedRow } | { ok: false; row: unknown } {
  const parsed = productRowGuardSchema.safeParse(row);
  if (parsed.success) {
    return { ok: true, row: row as ProductSeedRow };
  }

  const id = rowId(row);
  console.error('[catalog] product row failed validation', id, parsed.error.issues);
  Sentry.captureMessage('catalog row failed validation', {
    level: 'error',
    extra: { productId: id, issues: parsed.error.issues },
  });
  return { ok: false, row };
}

/**
 * Validate + filter a list of raw `products` rows, dropping (and reporting,
 * via `parseProductRow`) any row that fails the guard. Used by the
 * storefront-facing "skip" readers — see `parseProductRow`'s doc comment for
 * why this filtering behavior is NOT applied uniformly at every catalog
 * reader.
 */
export function parseProductRows(rows: unknown[]): ProductSeedRow[] {
  const out: ProductSeedRow[] = [];
  for (const row of rows) {
    const result = parseProductRow(row);
    if (result.ok) out.push(result.row);
  }
  return out;
}
