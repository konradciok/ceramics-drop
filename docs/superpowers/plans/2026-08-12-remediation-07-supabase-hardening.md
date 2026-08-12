# Remediation 07 — Supabase data-API & schema hardening (M-2 / M-3 / M-4 / L-10 / L-12 / L-13) — P1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §5 (Supabase group), §8, §13 Opp-7. Evidence re-verified at HEAD `3da7ee0`. **Migrations auto-apply to prod on merge to `main` (~1 min), before the ~7-min Workers build lands — every migration here must be backward-compatible with the still-running old code.**

**Goal:** Close the Postgres data-API surface (RPC `PUBLIC EXECUTE`), codify-or-drop the out-of-band live policies, make a NULL/zero ceramic price fail closed instead of selling a unique piece for 0 zł, bound the reservation TTL, and add the cheap same-migration index/constraint hygiene.

**Architecture:** One (or two — see steps) new timestamped migration(s) in `supabase/migrations/`, following the in-repo hardening precedents (`link_orders_rpc.sql:36-37` revokes, `harden_guarded_product_status.sql:112-114`, `print_fulfilment_assets.sql:41` status CHECK), plus a fail-closed change in the catalog read mapper with Zod, mirroring the existing write-side `schemas.ts`.

**Tech stack:** Supabase migrations (GitHub auto-apply), pgTAP (`supabase/tests/`, CI `db.yml`), Zod (already used in `src/lib/catalog/schemas.ts`).

## Objective

- No anonymous PostgREST caller can execute the four money-path RPCs (lock-contention DoS + private-sale token oracle today) — M-2.
- The live `piece_state` anon SELECT policies (present in prod, in **no** migration — schema drift) are dropped in a migration so migrations-are-truth is restored — M-3.
- A NULL/0 `price_pln` ceramic row cannot render or sell: DB CHECK + fail-closed mapper — M-4.
- `p_ttl_secs` is bounded server-side — L-10.
- The three unindexed FKs get indexes; `fulfilment_jobs.status` and `prodigi_orders.prodigi_status_stage` get CHECK constraints — L-12, L-13.

## Findings covered

- **M-2** (MEDIUM) → PLANNED
- **M-3** (MEDIUM `[CONFIRMED-LIVE]` drift) → PLANNED (drop in migration + origin investigation)
- **M-4** (MEDIUM) → PLANNED
- **L-10** (LOW) → PLANNED (same RPC edit as M-2's migration window)
- **L-12** (LOW) → PLANNED (cheap, same migration)
- **L-13** (LOW) → PLANNED (correction from inspection: the second target column is `prodigi_orders.prodigi_status_stage`, nullable — not `status`)
- **L-9** (audit-row-outside-txn in `publish_cms_version`) → **DEFERRED** — real but editorial-surface-only; the in-repo fix pattern exists (`update_product_status_guarded` writes audit in-txn) and can ride a future CMS change. Not a money path.
- **L-11** (`FOR SHARE` phantom window) → **DEFERRED** — theoretical write-skew on an admin-only path; revisit if variants become user-writable.
- **L-17** (undocumented intentional FK gaps) → **DEFERRED** to a docs pass; no behaviour change.
- **L-20** (USD/CAD dead-but-valid CHECK values) → **DEFERRED** — by design per audit.

## Current-state evidence

All `VERIFIED` at HEAD `3da7ee0`:

- **M-2** — grep across all 47 migrations: exactly three functions have revokes (`link_orders_to_user` at `20260723120200:36-37`, `update_product_status_guarded` at `20260717192143:112-114`, `promote_print_assets_ready` at `20260721120000:90-92`). **Zero** REVOKE/GRANT for `reserve_pieces`, `reserve_private_sale_pieces`, `publish_cms_version`, `publish_print_asset_revision` → default `EXECUTE TO PUBLIC` stands. Aggravator: `publish_print_asset_revision` was `DROP`ped and re-`CREATE`d in `20260712120000` (ACL reset to PUBLIC) and takes a caller-supplied `p_actor_email` — an audit-forgery vector independent of RLS. The stale comment in `link_orders_rpc.sql:7-9` cites `reserve_pieces` as the "house style" precedent for invoker-rights-without-revoke.
- **M-3** — **no migration contains any `CREATE POLICY` at all** (single grep hit is a prose comment). The anon SELECT policies on `piece_state` (incl. the duplicate permissive pair, advisor 0006) exist **only in the live DB** — `CONFIRMED-LIVE` by the audit; exact policy names are `NEEDS-RUNTIME-VERIFICATION` (read `pg_policies` before writing the migration).
- **M-4** — `catalog_shadow.sql:30` — `price_pln integer,` nullable, no CHECK (same for `price_eur/gbp`, `sale_price_*` :31-35; contrast :26 and :38 which DO have CHECKs). `product_variants.price_pln` (:62) is **intentionally** nullable ("null => inherit product price") — do not constrain it. Mapper: `src/lib/catalog/mappers.ts:62` `price: row.price_pln ?? 0`; read path `src/lib/catalog/repository.ts:34,99,134,172,224` uses raw `as ProductSeedRow[]` casts, zero runtime validation; write-side Zod exists (`schemas.ts:40` — note it's `.nonnegative()`, so even the admin editor permits 0 today). Production reads this path: `wrangler.jsonc:12-14` sets `CATALOG_SOURCE=db`; `resolveCartProducts`/`validateCart` consume it (`cart-lines.ts:10-11`, `checkout.test.ts:118,167`).
- **L-10** — `reserve_pieces` (`20260709130000:65-68,108-112`) and `reserve_private_sale_pieces` (`20260706120000:68-73,131-135`): `p_ttl_secs integer` flows bare into `make_interval`. Negative → instantly-expired reservation; huge → permanent hold. All call sites pass `900`.
- **L-12** — `product_media.variant_id` (`catalog_shadow.sql:92`, `on delete set null`), `products.drop_id` (:41), `prodigi_orders.order_id` (`20260626120002:20`) — none indexed (full index inventory checked). Precedent: `order_items.order_id` got a dedicated index migration (`20260703090000`).
- **L-13** — `fulfilment_jobs.status` (`20260626120002:5`) free text, while the one-active-job partial unique index (:13-15) string-matches `('cancelled','failed_action_required')` — a typo'd status silently breaks the uniqueness guarantee. `prodigi_orders` has **no** `status` column; the free-text nullable column is `prodigi_status_stage` (:22). CHECK precedent: `print_fulfilment_assets.sql:41`.
- pgTAP + CI `VERIFIED`: 4 suites in `supabase/tests/`; `.github/workflows/db.yml` runs `supabase db start && supabase test db`, **path-filtered to `supabase/**`** — this plan's migration edits will trigger it.

## Desired end state

- `revoke execute … from public, anon, authenticated; grant execute … to service_role;` applied to all four RPCs (both signatures where applicable), matching house precedent.
- `piece_state` back to deny-all: both live anon policies dropped by a committed migration; drift origin noted.
- `products.price_pln` (and the ceramic sale/EUR/GBP price columns) constrained `> 0` where non-null **and** NOT NULL for ceramic rows if data allows (see steps — data-dependent); mapper throws/excludes instead of `?? 0`; admin write schema tightened to `.positive()`.
- `p_ttl_secs` clamped in-function to `[60, 3600]`.
- Three FK indexes; two status CHECKs (`NOT VALID` + `VALIDATE` pattern for safety on existing rows).

## Scope

- New migration file(s) under `supabase/migrations/`
- `src/lib/catalog/mappers.ts`, `src/lib/catalog/repository.ts` (fail-closed read), `src/lib/catalog/schemas.ts` (`.positive()`)
- New/extended pgTAP file(s) under `supabase/tests/`
- Unit tests for the mapper

## Out of scope

- Wiring per-product EUR/GBP/sale prices into the storefront (§6.5 — backlog; L-40 parity check is Plan 04 Task 7).
- `reserve_pieces` behaviour changes beyond the TTL clamp (test-coverage expansion is Plan 12).
- RLS policies for authenticated account reads (Opp-9 — backlog).
- Any `pod_variants`/quantity-reservation work (§6.4/§6.7 — backlog).

## Implementation steps

### Task 0 — pre-migration live reads (read-only gate)

- [ ] Read the exact live policy names: `select polname, polcmd, polroles::regrole[] from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='piece_state';` (Supabase SQL editor or MCP, read-only). Record them — the migration's `DROP POLICY IF EXISTS` must name them exactly.
- [ ] Data check for M-4 constraints: `select count(*) from products where type='ceramic' and (price_pln is null or price_pln <= 0);` — expect 0. If non-zero rows exist, list them; constraining NOT NULL is blocked until they're fixed (operator decision), and the migration falls back to the CHECK-only variant.
- [ ] Data check for L-13: `select distinct status from fulfilment_jobs; select distinct prodigi_status_stage from prodigi_orders;` (both are 0-row tables per audit — expect empty; if not, the CHECK value lists must cover what exists).
- [ ] Enumerate every status value the **code** writes: grep `fulfilment_jobs`/`status:` under `src/server/fulfilment/` + `worker.ts`, and `prodigi_status_stage` writers (`status-map.ts` outputs: `fulfilment_submitted`, `in_production`, `shipped`, `cancelled`, plus `queued`, `fulfilment_submitting`, `failed_retryable`, `failed_action_required`, `completed` — build the definitive list from code, not from this plan).

### Task 1 — the hardening migration

- [ ] Create `supabase/migrations/<timestamp>_harden_rpc_and_catalog.sql` containing, in order:

```sql
-- 1) M-2: close default PUBLIC EXECUTE on the four legacy RPCs (house style:
--    link_orders_rpc.sql, harden_guarded_product_status.sql).
revoke all on function reserve_pieces(text[], uuid, integer) from public;
revoke execute on function reserve_pieces(text[], uuid, integer) from anon, authenticated;
grant execute on function reserve_pieces(text[], uuid, integer) to service_role;
-- …repeat for reserve_private_sale_pieces(<exact signature>),
--   publish_cms_version(<exact signature>),
--   publish_print_asset_revision(<exact 4-arg signature>).
-- (Copy exact signatures from the latest defining migrations listed in Evidence.)

-- 2) M-3: drop the out-of-band live policies (names from Task 0; IF EXISTS so
--    the migration is safe on shadow DBs where they never existed).
drop policy if exists "<live-name-1>" on piece_state;
drop policy if exists "<live-name-2>" on piece_state;

-- 3) L-10: clamp the TTL inside both reserve RPCs (CREATE OR REPLACE the
--    current definitions from 20260709130000 / 20260706120000 with one added
--    line near the top):
--      p_ttl_secs := least(greatest(coalesce(p_ttl_secs, 900), 60), 3600);
--    (Re-state the full current function bodies — do not diff-edit.)

-- 4) M-4: price guards, NOT VALID first so existing rows can't block the deploy:
alter table products add constraint products_ceramic_price_positive
  check (type <> 'ceramic' or price_pln is null or price_pln > 0) not valid;
alter table products validate constraint products_ceramic_price_positive;
-- If Task 0 confirmed zero NULL-priced ceramic rows, additionally:
-- alter table products add constraint products_ceramic_price_present
--   check (type <> 'ceramic' or price_pln is not null) not valid;
-- alter table products validate constraint products_ceramic_price_present;

-- 5) L-12: FK indexes (idempotent):
create index if not exists product_media_variant_idx on product_media(variant_id);
create index if not exists products_drop_idx on products(drop_id);
create index if not exists prodigi_orders_order_idx on prodigi_orders(order_id);

-- 6) L-13: status vocabularies (value lists from Task 0's code enumeration):
alter table fulfilment_jobs add constraint fulfilment_jobs_status_check
  check (status in (/* definitive list */)) not valid;
alter table fulfilment_jobs validate constraint fulfilment_jobs_status_check;
alter table prodigi_orders add constraint prodigi_status_stage_check
  check (prodigi_status_stage is null or prodigi_status_stage in (/* list */)) not valid;
alter table prodigi_orders validate constraint prodigi_status_stage_check;
```

- [ ] **Backward-compatibility review (required before merge):** revokes affect only `anon`/`authenticated` — all app code uses `service_role` (`VERIFIED`: every server path uses the service key), so the still-running old worker is unaffected. Policy drops restore deny-all — old code never relied on anon reads (`/api/inventory` reads via service role). CHECK constraints must not reject any value the **old still-running code** writes during the ~6-min window — hence Task 0's code enumeration covers HEAD *and* the constraint lists are supersets of both.
- [ ] Run locally: `supabase db start && supabase db reset` (applies all migrations) — expect clean apply.

### Task 2 — pgTAP coverage for the migration

- [ ] New `supabase/tests/rpc_hardening.sql`: assert (via `has_function_privilege`) that `anon` and `authenticated` lack EXECUTE on all four RPCs and `service_role` has it; assert zero policies on `piece_state` (`select count(*) from pg_policies where tablename='piece_state'` = 0); assert `reserve_pieces(..., -5)` and `(..., 999999)` produce a `reserved_until` within `[60s, 3600s]` of now; assert the price CHECK rejects a 0-priced ceramic insert and accepts a print row with NULL price; assert the status CHECKs reject a typo'd status (`'canceled'`).
- [ ] `supabase test db` locally — green.

### Task 3 — fail-closed catalog read (M-4 app side)

- [ ] Failing test first (`src/lib/catalog/mappers` tests): a row with `price_pln: null` or `0` for a ceramic is **excluded** from the mapped output and reported (`console.error` + `Sentry.captureException` via the existing error-reporting pattern in that layer) — never rendered at price 0. Excluding (fail-closed per-product) beats throwing (which would take down the whole collection page for one bad row) — record this decision in a comment.
- [ ] Implement at a **single centralized boundary that every production catalog reader passes through** — not just `readCeramicProducts`. The evidence lists raw `as ProductSeedRow[]` casts at `repository.ts:34, 99, 134, 172, 224`; a fix scoped to `:99` alone leaves the others able to feed a NULL/0-priced ceramic into checkout or rendering. Enumerate every reader (`listCatalogRows` :34, `readCeramicProducts` :99, `readPrintDesigns` :134, `readProductRow` :172, and the helper at :224) and route each through one shared `parseProductRow(row)` guard: a Zod row schema (extend `schemas.ts` or a sibling `read-schemas.ts`) with `price_pln: z.number().int().positive()` **for ceramic rows** (print rows keep nullable price — `type='print'` branch), `safeParse` per row, skip-and-report (`console.error` + `Sentry.captureException`) on failure. Replace the bare casts at all five sites with this guard so validation cannot be bypassed by a reader the fix forgot. In `mapCeramicProducts`, the `price: row.price_pln ?? 0` becomes unreachable for invalid rows (they never reach the mapper) — remove the `?? 0` fallback so a future bypass fails loudly rather than silently pricing at 0.
- [ ] Tighten the admin write schema `schemas.ts:40` from `.nonnegative()` to `.positive()` (0 was never a legitimate ceramic price).
- [ ] Add a test per reader path (five) proving a NULL/0-priced ceramic row is skipped+reported at each boundary, and a print row with NULL price passes untouched.
- [ ] `npx vitest run src/lib/catalog/` + `npm run typecheck` — green.
- [ ] Commit sequence: migration+pgTAP (`fix(db): …`), then mapper (`fix(catalog): fail closed on missing/zero ceramic price at every read boundary (M-4)`).

### Task 4 — M-3 origin note

- [ ] Add a short section to the migration header comment: the dropped policies existed only in the live DB (out-of-band creation, origin unknown — likely dashboard experimentation), and the migrations-are-truth invariant is restored by this migration. If the Supabase audit log (dashboard) reveals the creation origin cheaply, record it; do not spend more than a few minutes.

## Database / migration work

The migration above is the core of the plan. Key properties:
- **Backward compatible** with running code (service-role unaffected; constraints validated against enumerated live+code values; `NOT VALID`→`VALIDATE` avoids long locks on the tiny tables anyway).
- **Rollback:** a reverse migration (re-`grant execute to public` is NOT desired — instead rollback = drop the constraints/indexes if they misfire; the revokes and policy drops are the intended end state and would only be reverted by re-creating policies, which requires operator intent). Practically: each numbered block is independently revertible; write the reverse statements in the migration's header comment.
- **Auto-apply warning:** merging to `main` applies this to prod ~6 min before the new Worker code deploys. All blocks are safe under old code (verified in Task 1's review step); the mapper change (Task 3) is safe under the old DB too (it only adds validation). Merge as one PR.

## External-system changes

- Task 0's live reads (read-only, no gate needed beyond access).
- The migration itself auto-applies on merge — this **is** a production DB mutation; the merge is the gate. Do not apply by hand (AGENTS.md).
- After merge: `mcp get_advisors` / dashboard advisors re-run — expect advisor 0006 (duplicate permissive policies) gone.

## Tests

- **New:** `supabase/tests/rpc_hardening.sql` (privileges, policy count, TTL clamp, price CHECK, status CHECK); mapper unit tests (NULL price, 0 price, valid row, print row untouched).
- **Extended:** none required; existing pgTAP suites must stay green (`supabase test db` runs all).
- **Regressions caught:** future RPC re-creation dropping the revokes (privilege assertions); out-of-band policy reintroduction (policy-count assertion); mapper regressions back to `?? 0`.

## Verification

- **Local:** `supabase db start && supabase db reset && supabase test db` — full green run pasted. `npm test` + `npm run typecheck` green.
- **CI:** the `db.yml` workflow triggers (migration touches `supabase/**`) and passes.
- **Live read-only (post-merge):** `select has_function_privilege('anon','reserve_pieces(text[],uuid,integer)','execute');` → `f`; `select count(*) from pg_policies where tablename='piece_state';` → `0`; advisors list clean of 0006. (These queries are genuinely read-only.)
- **Live mutation (separate, gated):** confirming the checkout reservation path still works is a **state-changing** check — it runs `reserve_pieces`, creates an order + PaymentIntent, and reserves pieces. It is **not** read-only. Run it in **preview / Stripe test-mode** (piggyback Plan 05's rehearsal, which already exercises reserve→PI), or, only with explicit operator approval and immediate cleanup (cancel PI + release reservation), as a one-off live test-mode checkout. The auto-applied migration itself is the other production mutation (the merge is its gate).

## Rollout / recovery

1. Merge order within the PR: migration + pgTAP + mapper together (single PR, single deploy window).
2. Watch the Supabase migration run (~1 min post-merge) and then the Workers deploy; between them, old code runs against the hardened DB — verified safe above.
3. **Stop signals:** checkout 5xx spike right after the migration applies (would implicate the RPC changes — the TTL clamp is the only behavioural edit; rollback = `CREATE OR REPLACE` back to the prior function bodies); collection pages missing products (mapper too aggressive — check Sentry for the skip-reports).
4. **Recovery:** each block's reverse statement is in the migration header; the mapper change reverts by PR revert.

## Acceptance criteria

- [ ] `has_function_privilege` shows no anon/authenticated EXECUTE on the four RPCs (live output pasted).
- [ ] Zero policies on `piece_state` live; advisor 0006 resolved.
- [ ] A 0/NULL-priced ceramic row can neither be inserted (CHECK) nor rendered (mapper skip + Sentry report).
- [ ] `reserve_pieces` TTL provably clamped (pgTAP).
- [ ] Three FK indexes exist; typo'd statuses rejected.
- [ ] Local `supabase test db` + CI `db.yml` + `npm test` all green; one live checkout works post-merge.

## Dependencies

- Task 0's live reads require Supabase access (same access class as Plan 04). No plan-ordering dependencies; independent of Plans 01-06.

## Risks / unresolved questions

- Exact live policy names unknown until Task 0 — the migration cannot be finalized without them.
- If Task 0 finds NULL-priced ceramic rows in prod, the NOT-NULL half of M-4 is blocked pending data fix (operator decision on correct prices) — ship the CHECK-only variant and file the follow-up.
- `publish_cms_version` revoke: confirm the admin content path truly calls it with the service role (it does — `adminSupabase()`); if any future preview path used a lesser role it would break — grep for `.rpc('publish_cms_version'` callers during implementation to be sure.
