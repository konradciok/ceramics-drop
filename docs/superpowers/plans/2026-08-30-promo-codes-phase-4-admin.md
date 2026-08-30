# Promo Codes — Phase 4: Admin (operator management + stats)

> **For agentic workers:** Part of `2026-08-30-promo-codes-master.md` — master decisions/constraints binding. Depends on Phases 1–2. Worktree `feat/promo-codes`; commit per green step; self-review loop at the end.

**Goal:** Operators create, configure, activate/deactivate, inspect, and monitor promotions at `/admin/promotions`, with real utilization statistics. Built strictly on the existing `/admin/pricing` pattern (server page → client editor → `/api/admin/*` route → repository + audit log). Auth is the existing Cloudflare Access gate — the `/^\/api\/admin(\/|$)/` regex in `src/lib/admin/access.ts` already covers the new route; add **no** second auth layer, only verify coverage.

**Files:**
- Create: `src/lib/admin/promotions.ts` (repository + stats + zod schema)
- Create: `src/lib/admin/promotions.test.ts`
- Create: `src/app/api/admin/promotions/route.ts` (GET list+stats, POST create)
- Create: `src/app/api/admin/promotions/[id]/route.ts` (PATCH update/toggle)
- Create: `src/app/admin/promotions/page.tsx` (server, `force-dynamic`)
- Create: `src/app/admin/promotions/PromotionsEditor.tsx` (client)
- Modify: `src/app/admin/AdminNav.tsx` (add `{ href: '/admin/promotions', label: 'Promocje' }` to `LINKS`)

**Interfaces:**
- Consumes: Phase 1 schema (`promo_codes`, `promo_redemptions`, partial unique index on `newsletter_welcome AND active`), `normalizePromoCode`, `PromoCode` type; admin helpers `adminSupabase()`, `parseJson`, `actorEmail` (from `src/lib/admin/product-routes.ts` re-exports), `useToast`.
- Produces (Phase 5 relies on): `getActiveNewsletterPromo(supabase): Promise<PromoCode | null>` — added in **`src/lib/promo.ts`** by this phase (Phase 5 is storefront-side and must not import from `src/lib/admin/`): `from('promo_codes').select('*').eq('newsletter_welcome', true).eq('active', true).limit(1).maybeSingle()`. Include a unit test for it in `src/lib/promo.test.ts`.

**Data shapes:**
```ts
// zod input schema (create/update) — src/lib/admin/promotions.ts
const promoInputSchema = z.object({
  code: z.string(),                       // normalized server-side via normalizePromoCode; reject null
  kind: z.enum(['percent', 'fixed']),
  percent: z.number().int().min(1).max(100).nullable(),
  amount_pln: z.number().int().positive().nullable(),   // operator enters MAJOR units in the UI;
  amount_eur: z.number().int().positive().nullable(),   // editor converts to minor before POST
  amount_gbp: z.number().int().positive().nullable(),
  applies_to: z.enum(['all', 'ceramics', 'prints']),
  starts_at: z.string().datetime().nullable(),
  expires_at: z.string().datetime().nullable(),
  max_redemptions: z.number().int().positive().nullable(),
  newsletter_welcome: z.boolean(),
  campaign: z.string().max(120).nullable(),
})
// cross-field refinement mirrors the SQL CHECKs (percent required iff kind=percent, all
// three amounts required iff kind=fixed, starts_at < expires_at when both set).

export interface PromoStats {
  pending: number; redeemed: number; released: number
  discount_given_minor: { pln: number; eur: number; gbp: number }  // sum orders.discount of PAID+ orders, by currency
  revenue_minor: { pln: number; eur: number; gbp: number }         // sum orders.total of PAID+ orders with this code
  last_redeemed_at: string | null
}
export type PromoWithStats = PromoCode & { stats: PromoStats }
```

---

## Task 1: Repository + stats (TDD)

- [ ] **Step 1: Failing tests** in `src/lib/admin/promotions.test.ts` (stubbed Supabase client, style of `src/lib/admin/data.ts` consumers/tests): `listPromotions` returns promos with stats zeroed when no redemptions; `createPromotion` normalizes the code, rejects a duplicate (map PG 23505 → `{ status: 409, body: { error: 'code_exists' } }`), rejects a second active `newsletter_welcome` (unique-index violation → 409 `newsletter_welcome_taken`); `updatePromotion` supports partial patch incl. `active` toggle; every mutation inserts a `catalog_audit_log` row (`product_id: 'promo:'+code`, `action: 'promo:create'|'promo:update'`, `actor_email`, before/after) exactly like `src/lib/print-pricing-config/repository.ts` does.
- [ ] **Step 2: Implement** `src/lib/admin/promotions.ts`. Stats via two grouped queries (house style is plain PostgREST, no new RPC): (a) `promo_redemptions` counts by `(promo_id, status)`; (b) join through `orders` — select `promo_code, currency, discount, total, paid_at` from `orders` where `promo_code in (...)` and `status in ('paid','refunded')`, aggregate in TS. Return `ActionResult`-style `{ status, body }` from mutations (matching `src/lib/admin/actions.ts`) so routes stay thin adapters.
- [ ] **Step 3: Run tests to green. Commit** — `git commit -m "feat(promo): admin promotions repository with stats and audit log"`

## Task 2: API routes

- [ ] **Step 1:** `src/app/api/admin/promotions/route.ts` — GET: `NextResponse.json({ promotions: await listPromotions(adminSupabase()) })`; POST: `parseJson(req, promoInputSchema)` + `actorEmail(req)` → `createPromotion(...)` → `{ status, body }` passthrough. `[id]/route.ts` — PATCH with a partial schema (`promoInputSchema.partial()` + the same refinements where applicable) → `updatePromotion`. Copy the ~15-line thin-adapter shape of `src/app/api/admin/refund/route.ts` / `print-pricing/route.ts`.
- [ ] **Step 2:** Route tests (mirror `print-pricing` route tests if they exist; otherwise minimal request-level tests with mocked repository): 400 on schema violation with `{ error, fields }`, passthrough of repository status codes.
- [ ] **Step 3: Commit** — `git commit -m "feat(promo): /api/admin/promotions CRUD routes"`

## Task 3: Admin UI

- [ ] **Step 1:** `page.tsx` — server component, `export const dynamic = 'force-dynamic'`, reads `listPromotions(adminSupabase())` directly (fallback: error banner like pricing's), renders `<PromotionsEditor promotions={...} />`. Add the nav link to `AdminNav.tsx`.
- [ ] **Step 2:** `PromotionsEditor.tsx` — client component in the pricing-editor idiom (`postJson` helper, per-field `adm-field-error`, `useToast`, `router.refresh()` on success). Layout: a table of existing promotions — columns: code, kind/value (render `10%` or `50 zł / 12 € / 10 £`), applies_to, window, status pill (Aktywna/Nieaktywna/Wygasła — derive expired client-side from `expires_at`), redemptions `redeemed/max` (+ pending count as a muted suffix), discount given + revenue (formatted per currency, `src/lib/admin/money.ts` helpers), newsletter badge, last redeemed. Row actions: Aktywuj/Dezaktywuj (PATCH `{ active }`), Edytuj (inline form). Above the table: a "Nowa promocja" form with the schema's fields; fixed amounts entered in major units and converted to minor in the POST body; datetime-local inputs for the window. Admin UI copy is Polish (house style — check how `pricing`/`content` label things and match).
- [ ] **Step 3: Manual smoke** with `STUDIO_ADMIN_LOCAL_BYPASS` on `npm run dev`: render the page, exercise client-side validation. **Do not** create rows against the DB (prod!) — stub the POST via devtools or verify create/toggle only through the unit tests. Note this limitation for Phase 7.
- [ ] **Step 4: Commit** — `git commit -m "feat(promo): /admin/promotions management screen with utilization stats"`

## Acceptance checklist (phase self-review)

- [ ] `/api/admin/promotions*` paths are matched by `ADMIN_PATH_RE` in `src/lib/admin/access.ts` (verify by reading the regex — they are, but confirm) and no route does its own auth.
- [ ] No provider secret ever reaches the client; the editor talks only to `/api/admin/*`.
- [ ] Code normalization is server-side (`normalizePromoCode`) — the UI cannot create a code checkout would reject.
- [ ] Every mutation audit-logged with actor email, before/after.
- [ ] Deactivation is instantaneous for new checkouts (promo reads are uncached per master decision #10) — an operator turning a code off mid-checkout produces Phase 2's fail-closed 400 on the in-flight POST; note this behavior in the runbook (Phase 7).
- [ ] Stats reflect real data paths (redemptions ledger + orders join), not a denormalized counter that can drift.
- [ ] `npm run lint && npm run typecheck && npm run test` green; adversarial diff re-read done (watch: zod refinement parity with SQL CHECKs, major/minor unit conversion in the editor, 23505 mapping).
