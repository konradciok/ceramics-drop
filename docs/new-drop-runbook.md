# New drop runbook — launching a new batch of ceramics

Status: active runbook (2026-11-22).

A **drop** is a batch of one-of-a-kind pieces sold together. Every ceramic belongs to exactly one drop (`products.drop_id` → `drops`), and the drop's status decides where its pieces appear (`src/lib/drop-visibility.ts`):

| `drops.status` | Shop (`/sklep`, category pages, home, PDP siblings) | `/showroom` | PDP | Sitemap | Purchasable |
|---|---|---|---|---|---|
| `upcoming` | — | — | 404 | — | no |
| `active` (exactly one) | listed | "Ceramika dostępna online" | 200 | yes | yes |
| `ended` | — | "Wcześniejsze prace" archive | 200 + earlier-collection block | yes | no |

A product's own `status` (draft/hidden/archived) still withdraws a single piece on top of this. Display numbers (`Nº`) restart at 01 for every drop within a family; `noteIndex` stays positional across the family so existing notes never move.

## 1. Prepare the batch (content PR)

1. **Create the drop as upcoming** (needed first: `products.drop_id` has an FK to `drops`):
   ```bash
   npm run drop:create -- --id drop-2 --label "Drop Świąteczny"
   ```
2. **Photos.** Put the PNGs in `design/uploads/` (gitignored). Extend the filename whitelist in `scripts/optimize-images.mjs` for the new stem, run `npm run optimize-images`, and commit `public/uploads/*.webp` with all `-400w/-800w/-1600w` variants (`srcSet()` in `src/lib/images.ts` requires them).
3. **Registry.** Append new `SPECS` entries at the **end** of the list in `src/lib/products.ts` with `dropId: 'drop-2'`. Ids either continue the family's existing prefix with `startAt` (drop-2 vases: `{ prefix: 'v', startAt: 10 }` → v10–v15, after v01–v09) or take a new prefix (in use: k, v, d, t, s, p, b, w, c, x, u, g, h; also avoid `prd_`, `fap`, `gift-card:`, `print:`). A continued range must be unused in production (`products`, `piece_state`, `order_items`) — removed pieces keep their ids; `buildBase` throws on a duplicate within the registry. Never reorder or edit existing specs — ids would shift. Optional per-piece `PRICE_OVERRIDE` / `MEASURE_OVERRIDE` / `GALLERY_MERGE`.
4. **Copy.**
   - Add the drop's customer-facing name under `drops.drop-2` in all four `messages/*.json` (`"drops": { "drop-1": "Czerwcowy drop", "drop-2": "…" }`). It feeds the category eyebrow, the PDP and the lightbox.
   - Append each new piece's note to the **end** of `notes.<category>` in all four locales (`scripts/generate-product-notes.mjs` + `translate-product-notes.mjs` can draft them; the owner approves).
5. **piece_state migration** (`supabase/migrations/<ts>_drop2_pieces.sql`):
   ```sql
   insert into piece_state (product_id, status, showroom)
   values ('q01', 'available', false), ('q02', 'available', false)
   on conflict (product_id) do nothing;
   ```
   Without a row a piece is silently unbuyable (`reserve_pieces` treats it as a conflict).
6. **Counts.** Update `src/lib/products.test.ts` (total + per-category) and `src/lib/catalog/catalog-parity.test.ts`.
7. **Merge.** The Supabase GitHub integration applies the migration on merge to `main`; Workers Builds deploys the code.
8. **Backfill** the new rows into the DB catalogue (production reads `CATALOG_SOURCE=db`):
   ```bash
   npm run catalog:backfill
   ```
   The new products get `drop_id = 'drop-2'`; the drop is `upcoming`, so customers still see nothing.
9. **Check before launch:** a new PDP (`/kubki/q01`) answers 404 and is absent from `/sitemap.xml`; the live shop is unchanged; `/admin/products` lists the new pieces.

## 2. Launch day

```bash
npm run drop:launch -- --id drop-2                    # dry run: counts, refuses if products/piece_state are missing
npm run drop:launch -- --id drop-2 --confirm drop-2   # ends drop-1 and activates drop-2 in one transaction
```

Verify:
- `/sklep`, every category page and the homepage list only drop-2;
- `/showroom` shows the previous drop under "Wcześniejsze prace";
- an old PDP (`/kubki/k01`) answers 200 with the earlier-collection block;
- a new piece can be added to the cart and checked out; an old one cannot;
- category eyebrows read the new drop name.

Then bump `FALLBACK_CURRENT_DROP_ID` in `src/lib/products.ts` to `drop-2` in a small follow-up PR. It is the drop shown as current if the `drops` table cannot be read; other drops are withheld during such an outage and crawlers get a 503.

## Notes

- `launch_drop()` (migration `20261122130000_drop_lifecycle.sql`) only moves `upcoming → active` and the old `active → ended`. At most one drop is `upcoming` and one `active`.
- Ending a drop in `/admin/inventory` without a successor moves its pieces to the `/showroom` archive and **empties the shop listings** (`/sklep`, category pages) until another drop is launched. For a batch change use `drop:launch`.
- Old carts holding ended-drop pieces are pruned with a notice (`/api/inventory`), and checkout rejects them (`ceramic_drop_conflicts`).
- `npm run catalog:backfill` never changes a drop's status, so re-running it cannot republish an archived batch into the shop.
