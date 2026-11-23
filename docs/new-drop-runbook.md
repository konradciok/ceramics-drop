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

1. **Create the drop as upcoming** — `products.drop_id` has an FK to `drops`, so the row must exist before the backfill. Seed it in the content PR's migration (drop-2 did: `insert into drops (id, label, status) values ('drop-2', 'Drop Świąteczny', 'upcoming') on conflict (id) do nothing` in `20261123120000_drop2_seed.sql`); CI's fresh-schema backfill rehearsal fails without it. `npm run drop:create -- --id drop-3 --label "…"` does the same by hand against the database in your env.
2. **Photos.** Give each family a filename stem that is **not already in `public/uploads/`** — drop-1 owns `kubek-1…31`, so drop-2's mugs became `kubek-drop2-1…18`; a reused stem would overwrite live drop-1 images. Extend the filename whitelist in `scripts/optimize-images.mjs` for the new stems, then convert only the new photos with `node scripts/optimize-images.mjs --src <dir>` (PNG or JPEG; drop-2 used `design/drop-2/_with_background/<family>/`). Commit `public/uploads/*.webp` with all `-400w/-800w/-1600w` variants (`srcSet()` in `src/lib/images.ts` requires them), and check that `git status` shows only new files there.
3. **Registry.** Append new `SPECS` entries at the **end** of the list in `src/lib/products.ts` with `dropId: 'drop-2'`. Ids either continue the family's existing prefix with `startAt` (drop-2 vases: `{ prefix: 'v', startAt: 10 }` → v10–v15, after v01–v09) or take a new prefix (in use: k, v, d, t, s, p, b, w, c, x, u, g, h; also avoid `prd_`, `fap`, `gift-card:`, `print:`). A continued range must be unused in production (`products`, `piece_state`, `order_items`) — removed pieces keep their ids; `buildBase` throws on a duplicate within the registry. Never reorder or edit existing specs — ids would shift. Optional per-piece `PRICE_OVERRIDE` / `MEASURE_OVERRIDE` / `GALLERY_MERGE`.
4. **Copy.**
   - Add the drop's customer-facing name under `drops.drop-2` in all four `messages/*.json` (`"drops": { "drop-1": "Czerwcowy drop", "drop-2": "…" }`). It feeds the category eyebrow, the PDP and the lightbox.
   - Append each new piece's note to the **end** of `notes.<category>` in all four locales (`scripts/generate-product-notes.mjs` + `translate-product-notes.mjs` can draft them; the owner approves).
5. **piece_state rows** in the same migration:
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

Then, in a small follow-up PR:
- bump `FALLBACK_CURRENT_DROP_ID` in `src/lib/products.ts` to `drop-2`. It is the drop shown as current if the `drops` table cannot be read; other drops are withheld during such an outage and crawlers get a 503;
- un-hide any family that is new in this drop: remove it from `HIDDEN_CATEGORIES` in `src/lib/products.ts` and add its path to `SITE_PATHS` in `src/lib/site.ts` (drop-2: `talerze-owalne`). Merge it right after `drop:launch` — until then the new family has no listed piece, and the nav, footer and sitemap would point at an empty page.

A family that has **no** pieces in the new drop is not hidden automatically: after the launch its category page lists nothing (the old pieces move to `/showroom`), while the nav and footer still link to it.

## New category

A drop that brings a brand-new family (drop-2: `talerze-owalne`) also needs, in the content PR:
- `CategorySlug` in `src/lib/types.ts`; `CATEGORIES`, `CATEGORY_ORDER` and `HIDDEN_CATEGORIES` (hidden until launch) in `src/lib/products.ts`;
- `PRICE_PLN` / `PRICE_EUR` / `PRICE_GBP` in `src/lib/pricing.ts`; a `PACK_SPECS` entry in `src/lib/packing.ts`; the admin label in `src/lib/admin/products.ts`;
- the slug lists in `src/lib/catalog/schemas.ts`, `src/server/cms-api/validation.ts`, `src/server/cms-api/handlers/capabilities.ts`, `contracts/cms-v1.json` (+ `contracts/fixtures/capabilities.json`), `scripts/lib/catalog-runtime-artifact.ts`, `scripts/translate-product-notes.mjs`, `scripts/notion-i18n/lib.mjs`;
- a migration widening `products_ceramic_category_valid` (else `catalog:backfill` fails) and its pgTAP case in `supabase/tests/ceramic_category_check.sql`;
- copy in all four `messages/*.json`: `nav.<key>`, `title.<key>`, `meta.collections.<key>`, `collection.<slug>`, `product.<singularKey>`, `cart.see<…>` (and a `SEE_KEYS` entry in `CartView.tsx`), `notes.<slug>`;
- tests that pin the category list or counts (`products`, `pricing`, `capabilities`, admin/CMS content).

The CMS contract's `info.version` is left unchanged for a new enum value: bumping it locks cms-ceramics writes (CONTRACT_MISMATCH) until that client ships the new contract; update its pinned copy to edit the new family there.

## Notes

- `launch_drop()` (migration `20261122130000_drop_lifecycle.sql`) only moves `upcoming → active` and the old `active → ended`. At most one drop is `upcoming` and one `active`.
- Ending a drop in `/admin/inventory` without a successor moves its pieces to the `/showroom` archive and **empties the shop listings** (`/sklep`, category pages) until another drop is launched. For a batch change use `drop:launch`.
- Old carts holding ended-drop pieces are pruned with a notice (`/api/inventory`), and checkout rejects them (`ceramic_drop_conflicts`).
- `npm run catalog:backfill` never changes a drop's status, so re-running it cannot republish an archived batch into the shop.
