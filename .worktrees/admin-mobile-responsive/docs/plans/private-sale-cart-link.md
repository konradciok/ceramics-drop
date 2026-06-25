# Private sale cart link — implementation plan

## Context

Anna wants to sell four specific already-`sold` pieces (`k10`, `t18`, `t19`, `t22`) to a single customer via a shareable link, **without re-listing them in the public shop**. Today this is impossible without code: the cart is browser-only `localStorage` (`acc_cart_v1` in `src/store/cart.ts`), there is no server-side cart/ID, and both the public reservation RPC (`reserve_pieces`) and the on-mount prune effect in `CartView` actively block buying `sold` pieces.

This plan adds a tokenised private-sale link: `/koszyk?sale=<TOKEN>`. A secret token in a new `private_sales` table maps to an exact set of product IDs. Opening the link seeds the cart from the token, a dedicated RPC reserves the (sold) pieces, and after payment the pieces simply stay `sold` — the public catalogue never changes.

The original draft (`.cursor/plans/private_sale_cart_link_1e7ec1e4.plan.md`) was verified against the code and is **architecturally correct**. This version fixes gaps it missed (extra release call-sites, refund handling, single-use timing, display-window race) and bakes in three confirmed product decisions:

- **Creation surface:** CLI script only (the `/admin` section has no auth — no new write endpoint there).
- **Cart in private-sale mode:** **locked bundle** — exact set match, remove disabled, additions ignored.
- **Refund of a private sale:** pieces **stay `sold`** (do not re-list publicly).

## Confirmed facts from exploration (do not re-derive)

- `src/store/cart.ts` — Zustand `{ ids, add, remove, clear }`, persisted to `acc_cart_v1`. **No `replace`/`seed` action** → add one.
- `src/components/shop/CartView.tsx` — on-mount effect (≈L134–142) prunes `sold` via `GET /api/inventory`; uses `resolveCartProducts(ids)` (≈L144); POSTs `{ ids, ...deliveryBody(), marketing_cookies }` to `/api/checkout` (≈L230–235); error keys `cart.soldOut|rateLimited|checkoutError|payError`.
- `src/lib/products.ts` — **`resolveKnownProducts(ids)` already exists** (keeps sold) vs `resolveCartProducts` (drops sold). Reuse `resolveKnownProducts` in private-sale mode. `getProductById` / `PRODUCT_BY_ID` exported. Targets: `k10` kubki (95 PLN/25 EUR), `t18`/`t19`/`t22` talerze-srednie (119 PLN/28 EUR).
- `src/app/api/checkout/route.ts` — loosely-typed body; derives currency from locale; `validateCart(body.ids, currency)`; `supabase.rpc('reserve_pieces', { p_ids, p_order_id, p_ttl_secs })`; 409 `{ error:'unavailable', sold }` on conflict; `orderId = crypto.randomUUID()`.
- `src/lib/checkout.ts` — `validateCart` checks existence + computes minor-unit price; **does NOT filter sold** (server already permits sold; UI does the filtering). No change needed.
- DB (`supabase/migrations/20260602213032_stripe_orders.sql`): `piece_status` enum = `available|reserved|sold`; `reserve_pieces` rejects `sold` and unexpired `reserved`, returns conflicts `text[]`; search_path hardened in `20260608120000_*`. `orders` has **no** `private_sale_id`.
- Release call-sites doing `→available` / `→sold`:
  - `src/app/api/stripe/webhook/route.ts`: `releaseHold` (pending→failed, pieces `reserved→available`), `releaseSale` (paid→refunded, pieces `sold→available`, throws on failure), `markPaid` (pending→paid, pieces `reserved→sold`; under-fulfilment path reverts sold→available + refunds).
  - `src/lib/expire-orders.ts` — DI-based sweep; `expireOrder` dep frees reserved pieces (testable pattern to mirror).
  - **`src/app/api/admin/release-reservation/route.ts`** — manual "free stuck reservation", `reserved→available` (the draft missed this).
- `src/lib/inventory.ts` — `getSoldIds()` = `piece_state` where `status='sold'`, cached (tag `inventory`, revalidate 300); webhook calls `revalidateTag('inventory')`.
- Scripts: `.ts` via `tsx` (devDep present); env loaded from `.env.local`/`.dev.vars`/`process.env`; `createClient(URL, SERVICE_ROLE_KEY, { auth:{ persistSession:false }})`. Precedent: `scripts/generate-product-stock-snapshot.ts`.
- `crypto.randomUUID()` available in both scripts and Workers runtime. No existing private-sale/token/share-cart code anywhere.

## Design

### 1. Migration — `supabase/migrations/<ts>_private_sales.sql`

**Table `private_sales`** (service-role only; RLS enabled, no public policy):
- `id uuid pk default gen_random_uuid()`
- `token text unique not null`
- `product_ids text[] not null`
- `expires_at timestamptz not null`
- `consumed_at timestamptz` (null until paid — single-use)
- `created_at timestamptz not null default now()`

**Column** `orders.private_sale_id uuid null references private_sales(id)`.

**RPC `reserve_private_sale_pieces(p_token text, p_ids text[], p_order_id uuid, p_ttl_secs integer) returns text[]`** — mirror `reserve_pieces` style, `set search_path = public, pg_temp`, `for update` lock. Logic:
1. Look up active sale: `token = p_token AND consumed_at IS NULL AND expires_at > now()`. Not found → return the sentinel conflict `'{__invalid_token__}'` so the route maps it to 410/404.
2. **Exact set match** (locked bundle): `p_ids` and `product_ids` equal as sets. Mismatch → return them as conflicts.
3. For each id: allowed only if `status = 'sold'` (v1 re-sale) **OR** already `reserved` **by this same `p_order_id`** (retry idempotency) **OR** expired reservation. A piece reserved by a *different* live order → conflict.
4. `update piece_state set status='reserved', reserved_until=now()+make_interval(secs=>p_ttl_secs), order_id=p_order_id where product_id = any(p_ids)`.
5. Return `'{}'`. (`orders.private_sale_id` is stamped route-side on insert — single owner.)

`reserve_pieces` stays untouched — the public shop gains no hole.

> Note: `consumed_at` is **NOT** set here. It is set on payment success in `markPaid` (below), so an abandoned checkout never burns the link.

### 2. Shared release helper — `src/lib/piece-release.ts` (new, DI-testable)

Extract the "where should freed pieces land" decision into one pure-ish helper used by all release paths, mirroring `expire-orders.ts` dependency-injection so it is Vitest-testable without a DB.

- Input: an order row including `private_sale_id` + a Supabase-like updater dep.
- Rule: **if `private_sale_id` is set → restore pieces to `sold`; else → `available`** (current behaviour).
- Used by:
  - `releaseHold` (webhook) — currently `reserved→available`.
  - `releaseSale` (webhook, **refund**) — currently `sold→available`; for private sale must keep `sold` (confirmed). For private sale this becomes effectively a no-op on `piece_state` but still flips `orders.status→refunded`.
  - `expireOrder` (the `expire-orders.ts` dep / worker cron).
  - **`src/app/api/admin/release-reservation/route.ts`** — manual release must also respect the branch.

Each of these already (or will) `select` the order; add `private_sale_id` to those selects.

`markPaid` happy path is unchanged (`reserved→sold` is correct). In `markPaid`, after a successful new sale where `private_sale_id` is set, also `update private_sales set consumed_at = now() where id = private_sale_id and consumed_at is null` (idempotent). Its under-fulfilment revert path (sold→available + refund) is an unlikely edge for a 1–4 piece manual sale; leave as-is but note it would relist — acceptable for v1.

### 3. API

- **`GET /api/private-sale?token=...`** (new route) → validates token (`consumed_at IS NULL AND expires_at > now()`); returns `{ product_ids }`. Invalid/expired/consumed → uniform `404` (no enumeration signal). Single source of truth for what the link contains.
- **`POST /api/checkout`** — accept optional `private_sale_token`. When present: call `reserve_private_sale_pieces` instead of `reserve_pieces`, and persist `private_sale_id` on the `orders` insert. `validateCart` unchanged. Map the RPC's invalid-token sentinel to `410`/`404`; map set-mismatch conflicts to the existing `409 { error:'unavailable', sold }`.

### 4. Frontend — locked bundle

- `src/store/cart.ts`: add `replace(ids: string[])` (set `ids` wholesale).
- `src/app/[locale]/koszyk/page.tsx`: read `searchParams` (`sale`) server-side (pattern from `zwrot/page.tsx`), pass token to `CartView`/`CartLinkSeed`.
- `CartLinkSeed` (client): on mount, `GET /api/private-sale?token=...`; on success `replace(product_ids)` + stash token in `sessionStorage` (`acc_private_sale_token`); on failure show i18n error (new key `cart.privateSaleInvalid`, add to `pl`/`en`/`es`).
- `CartView` private-sale mode (active when token present):
  - **Skip** the on-mount `/api/inventory` prune effect.
  - Resolve with **`resolveKnownProducts`** (keeps sold) instead of `resolveCartProducts`.
  - **Disable the Remove control**; ignore additions (locked bundle).
  - Include `private_sale_token` in the `/api/checkout` POST body.
  - Map a 404/410 checkout response to `cart.privateSaleInvalid`.
- Shop / PDP / tiles: **unchanged** — pieces remain `sold` in the catalogue.

### 5. Known limitation — reservation display window

While reserved (`sold→reserved`, ≤ TTL), `getSoldIds()` (status=`sold` only) no longer reports the piece, so collection pages would briefly render it as available; a public buyer's checkout would then 409 via `reserve_pieces`. Low impact for 1–4 curated pieces during a short window.
- **v1:** accept and document. The link should be paid promptly; TTL bounds the window.
- **Optional hardening:** extend `getSoldIds()` to also treat pieces `reserved` by an order with `private_sale_id` as sold.

### 6. CLI script — `scripts/create-private-sale-link.ts`

`npx tsx scripts/create-private-sale-link.ts --items k10,t18,t19,t22 --days 14`
- Load env like `generate-product-stock-snapshot.ts`; `createClient(URL, SERVICE_ROLE_KEY, {auth:{persistSession:false}})`.
- Validate each id via `getProductById` (fail fast on typos).
- `token = crypto.randomUUID()`; insert `private_sales` row with `expires_at = now + days`.
- Print: `https://anna-ciok.studio/koszyk?sale=<TOKEN>` (pl root → PLN; `/en` or `/es` for EUR).
- Add npm alias `"private-sale:create": "tsx scripts/create-private-sale-link.ts"`.

### 7. Tests (Vitest)

- `reserve_private_sale_pieces` decision logic — pure helper (exact match pass, mismatch conflict, sold-allowed, reserved-by-other conflict, same-order retry idempotent, expired/consumed token rejected).
- `piece-release` helper — DI tests: `private_sale_id` set → `sold`; unset → `available`.
- `consumed_at` set-once idempotency in `markPaid` (mocked Supabase).
- Optional: light `/api/checkout` route test asserting `reserve_private_sale_pieces` is called + `private_sale_id` persisted when `private_sale_token` present.

## Files to change (summary)

- `supabase/migrations/<ts>_private_sales.sql`
- `src/lib/piece-release.ts` (new) + wiring in `webhook/route.ts`, `expire-orders.ts`, `admin/release-reservation/route.ts`
- `src/app/api/private-sale/route.ts` (new GET)
- `src/app/api/checkout/route.ts` (private-sale branch + persist `private_sale_id`)
- `src/store/cart.ts` (`replace()`); `src/app/[locale]/koszyk/page.tsx` + new `CartLinkSeed.tsx`; `src/components/shop/CartView.tsx`
- `messages/{pl,en,es}.json` (`cart.privateSaleInvalid`)
- `scripts/create-private-sale-link.ts` + `package.json` alias
- Tests under `src/**/*.test.ts`
- No new secrets (`.env.example` unchanged — tokens live in DB)

## Verification (end-to-end)

1. `npm run lint && npm run test` — all green.
2. Apply migration to **dev** Supabase; create a fixture sold piece; mint a link via the CLI.
3. Local `npm run dev`, open `/koszyk?sale=<TOKEN>` → bundle shown (sold present), Remove disabled, prune does not clear it.
4. Stripe **test-mode** checkout → `markPaid`: pieces stay `sold`, `consumed_at` set, order `paid`.
5. Re-open the link → `404`/invalid (single-use).
6. Negatives: tampered/expired token → 404; mismatched `p_ids` → 409; abandoned checkout (TTL/cron) → pieces return to **`sold`**, link still usable.
7. Refund (`charge.refunded`) → order `refunded`, pieces remain **`sold`**; `getSoldIds()` still reports them.
8. Confirm public shop never shows the pieces as available (note §5 caveat).
9. **Before sending the real link:** apply the migration to **production** Supabase, then mint the prod link via the CLI.
