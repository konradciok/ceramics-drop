# Promo Codes — Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Each phase is a separate prompt file (linked below) with its own checkboxed tasks. **Execute in a dedicated git worktree** (superpowers:using-git-worktrees), branch `feat/promo-codes`, with frequent commits and a self-review loop at the end of every phase.

**Goal:** Production-ready promo codes that work in both checkout tracks (ceramics and fine-art prints), are fully operator-managed from the existing `/admin` dashboard, are delivered to new newsletter subscribers via the Resend welcome email, and are instrumented in GA4/Meta following the repo's existing analytics conventions.

**Architecture:** Supabase owns promotion definitions and lifecycle (the shop uses raw Stripe **PaymentIntents**, and Stripe coupons/promotion codes are *not supported* with the PaymentIntents API — verified against Stripe docs 2026-08-30: https://support.stripe.com/questions/support-for-coupons-using-payment-intents-api , https://docs.stripe.com/payments/advanced/discounts). The discount is computed server-side in `/api/checkout` at the single existing total-computation site and reflected in the PaymentIntent `amount`; the PI carries `promo_code` metadata for Stripe-side reporting. Redemptions are claimed atomically at checkout via an RPC (mirroring `reserve_pieces`) and finalized/released from the Stripe webhook + expiry cron (mirroring the private-sale token burn in `markPaid`).

**Tech Stack:** Next.js 16 App Router on Cloudflare Workers (OpenNext), Stripe PaymentIntents, Supabase (service-role, RLS on), Resend (raw fetch, HTML-string templates), GA4/Meta via GTM + server-side MP/CAPI, Vitest + Playwright.

**Spec:** This file *is* the spec (the original free-form requirement is condensed in "Requirement" below). Phase prompts: see "Phase index".

---

## Requirement (condensed from the original brief)

1. Customers can enter and apply an eligible promo code in **both** checkout tracks (ceramics cart and fine-art-print cart).
2. Validation and the payable amount are established **server-side** — never trust client-supplied discounts.
3. Operators manage the full lifecycle from the existing admin dashboard: create, configure, activate, deactivate, view status, view meaningful utilization statistics.
4. "when someone will assign it's a new silter he will receive the promo code in the inviting email" — **resolved interpretation:** "new silter" is a typo for **newsletter**. The only invitation-like email flow in the repo is the newsletter double opt-in (`src/lib/newsletter.ts`); there is zero repo prior art for "invite"/"silter"/"sitter" (verified by repo-wide grep 2026-08-30). Adapted requirement: a **new newsletter subscriber** receives a designated promo code in a **welcome email** sent after successful double-opt-in confirmation. This interpretation MUST be confirmed with the operator before Phase 5 ships to production; the implementation isolates it so it is cheap to re-wire if the meaning differs.
5. Promo lifecycle and redemption are visible in GA4 (and Meta where applicable) using existing event conventions; no duplicate/conflicting attribution.
6. Reliability: invalid/deactivated codes, provider failures, concurrent redemption, duplicate webhook delivery, operator-deactivates-mid-checkout, and email/analytics failures must not corrupt payment state.

## Non-goals (explicit)

- No Stripe-native coupons/promotion-code objects (unsupported with PaymentIntents).
- No free-shipping promos, no per-customer unique single-use codes, no stacking (one code per order), no minimum-subtotal thresholds. All are additive later; the schema leaves room but Phase 1 does not build them.
- No mixed-cart changes (mixed ceramic+print carts remain blocked upstream of promo logic).
- No refund clawback of a redemption for **paid** orders (a refunded paid order's redemption stays `redeemed` and counted; documented operator behavior). A refund that lands on a never-paid order (the webhook's pending→refunded path) is not a clawback — that claim settles `released` like any other unpaid outcome (Phase 2).

## Verified discovery digest (2026-08-30 — re-verify anchors before editing; line numbers drift, symbols don't)

**Checkout server** — `src/app/api/checkout/route.ts`:
- Request body: `{ ids: string[], attemptId: uuid, locale, delivery_method, contact, target_point?, address?, marketing_cookies?, private_sale_token? }`. Currency comes from the `currency_pref` cookie, **not** the body (`toChargeableCurrency(currencyFromCookieHeader(...))`, ~line 70).
- Totals (~lines 146–176, minor units): `subtotalMinor` from `validateCart` item `unit_price`s; prints add `printShippingOf(...)`; ceramics use `orderAmountGrosze/EuroCents/GBPPence(unitPrices, method)` from `src/lib/pricing.ts`. **This is the single place a discount is subtracted.**
- PI creation (~271–303): `stripe.paymentIntents.create({ amount, currency, payment_method_configuration, metadata: { order_id, product_ids, delivery_method, fulfilment_type, ... } }, { idempotencyKey: 'pi_create_'+orderId })`.
- `orders` insert (~385–410): `id, payment_intent_id, status:'pending', currency, subtotal, shipping (currently derived as amount − subtotalMinor — Phase 2 must make shipping explicit once discount exists), total, ..., locale, marketing, private_sale_id, user_id`. Then `order_items`.
- Idempotency: `attemptId` (client uuid in `localStorage['acc_checkout_attempt_v1']`) becomes the order id; replay-safe reserve RPC; Stripe idempotency key per order; PG 23505 on `orders` treated as replay when row is `pending`. Errors: 409 `checkout_in_progress` / `order_conflict`, 429 rate-limit via `createCheckoutRateLimiter()`.

**Cart UI** — one shared component for both tracks: `src/components/shop/CartView.tsx` (page `src/app/[locale]/koszyk/page.tsx`). Totals computed ~257–266, rendered in `.sum-row`/`.sum-total` ~879–890 + sticky CTA ~813–815. `handleCheckout()` ~346, `fetch('/api/checkout')` ~375, `begin_checkout` via `pushCheckoutStartedItemsOnce` ~359 (`src/lib/checkout-analytics.ts:77`). Return-page purchase snapshot written by `rememberCheckoutForReturn` ~460.

**validateCart** — `src/lib/checkout.ts`: `validateCart(rawIds, currency): Promise<ValidateResult>`; `CheckoutItem = { product_id, unit_price /* minor units */, variant? }`. Print unit prices resolved server-side ("THE price of record").

**Admin pattern (template for Promotions)** — `/admin/pricing`: server page `src/app/admin/pricing/page.tsx` (`force-dynamic`, reads via `adminSupabase()`) → client editor `PricingEditor.tsx` → `POST /api/admin/print-pricing` (`parseJson(req, zodSchema)` + `actorEmail(req)` from `src/lib/admin/content-routes.ts`) → repository in `src/lib/print-pricing-config/repository.ts` with `catalog_audit_log` audit insert. Auth: Cloudflare Access verified in `worker.ts` (`src/lib/admin/access.ts`), trusted `X-Admin-Actor-Email` header; local bypass `STUDIO_ADMIN_LOCAL_BYPASS`. Nav: `LINKS` array in `src/app/admin/AdminNav.tsx`. Mutating admin routes are thin adapters over `src/lib/admin/actions.ts` functions returning `ActionResult = { status, body }`.

**Webhook** — `markPaid` lives in `src/app/api/stripe/webhook/route.ts` (~356–597), found by `payment_intent_id` (does not read PI metadata). The private-sale token burn (~583–595: guarded idempotent UPDATE, throws on failure so Stripe retries) is the structural precedent for redemption finalization. Order of ops: `markPaid` → `trackPurchase` (~957, claims `conversions_sent_at`) → `ensureInvoiced` → fulfilment. `releaseHold` frees pieces on `payment_intent.payment_failed`/`canceled`; the `worker.ts` cron expires abandoned orders after 1 h.

**Newsletter** — stateless double opt-in, no DB table. `POST /api/newsletter` sends only the confirm-link email (`buildNewsletterConfirmEmail`); `GET /api/newsletter/confirm` verifies HMAC token → creates Resend contact → 302 redirect. **No welcome email exists today.** Email house style: pure `buildXEmail(params) => { subject, html }` builders in `src/lib/email.ts` using `src/lib/email-layout.ts` primitives (`resendTemplateHtml`, `emailParagraph`, `emailButton`, ...), locale copy inlined in code (emails render outside next-intl), raw `fetch` to `api.resend.com`.

**Analytics** — client: `buildEngagementEvent(engagementType, properties)` (`src/lib/analytics.ts:433`) → `site_engagement`; `buildBeginCheckoutEventFromItems` (~356) and `buildPurchaseEventFromItems` (~390, deduped by `acc_purchase_pi:<pi>`); return-page purchase reads the `acc_checkout_snapshot` written at checkout. Server: `src/lib/marketing/ga4-mp.ts` `buildGa4PurchasePayload` — **no `coupon` field exists yet**, `value = order.subtotal/100`; assembled in `src/lib/marketing/conversions.ts` (`ConversionOrder` at ~:12), Meta value = `order.total/100`.

**DB conventions** — migrations `supabase/migrations/<YYYYMMDDHHMMSS>_<desc>.sql` with a `-- ===` rationale banner; RPCs are `language plpgsql`, invoker rights (house style: **no** `security definer`), `set search_path = public, pg_temp`, called via `supabase.rpc('name', {p_...})`. **No generated DB types** — untyped `SupabaseClient` + inline result casts. ⚠️ Merging to main **auto-applies migrations to prod (~41 s) before** the ~7-min Workers deploy — migrations must be purely additive/backward-compatible with running code.

**Tests** — `src/app/api/checkout/route.test.ts` (~40 cases, mocked Stripe/Supabase), `src/lib/checkout.test.ts`, `src/app/api/stripe/webhook/route.test.ts`, etc. Playwright: hermetic `@ci` specs intercept **the app's own API** (`page.route('**/api/checkout', ...)`) — never real Stripe; helpers in `e2e/helpers/checkout.ts`; `@destructive` specs are the only ones touching real Stripe.

**No discount prior art** — repo-wide grep for promo/coupon/discount/rabat/voucher/kupon returns nothing real. Closest analogue: private sales (`src/lib/private-sale.ts`, `supabase/migrations/20260615120000_private_sales.sql`).

## Locked architecture decisions

1. **Source of truth:** Supabase table `promo_codes` owns definitions + lifecycle; `promo_redemptions` owns usage. Stripe sees only the discounted `amount` + `promo_code`/`promo_id` in PI metadata (reporting/reconciliation only).
2. **Discount semantics:** applies to the **merchandise subtotal only, never shipping**. Two kinds: `percent` (integer 1–100, `discount = floor(subtotalMinor * percent / 100)`) and `fixed` (explicit per-currency minor-unit amounts `amount_pln/amount_eur/amount_gbp`, clamped to subtotal). Final clamp (Stripe minimum): the maximum discount is `max(0, subtotalMinor + shippingMinor − STRIPE_MIN[currency])` (PLN 200 / EUR 50 / GBP 30 minor units) — i.e. `discount = min(discount, max(0, subtotalMinor + shippingMinor − stripeMin))`, so the charge lands exactly on the minimum when the clamp bites and the discount floors at 0. An undersized cart that is already below the minimum with no discount keeps `discount = 0` — that cart's chargeability is not the promo's problem and the code is not rejected for it. One code per order, no stacking.
3. **Eligibility:** `applies_to ∈ {'all','ceramics','prints'}` checked against the cart's fulfilment type (carts are never mixed); `active` flag; optional `starts_at`/`expires_at` window; optional `max_redemptions` (counts `pending + redeemed`).
4. **Order columns:** `orders.promo_code text` (normalized code, denormalized for emails/admin/analytics) + `orders.discount integer default 0` (minor units). `orders.subtotal` stays **pre-discount**; `total = subtotal − discount + shipping`.
5. **Redemption lifecycle:** claim `pending` atomically via RPC `claim_promo_redemption(p_promo_id, p_order_id)` — called **after the `orders` row is inserted** (the redemption's `order_id` FK requires it; the existing checkout inserts `orders` only after PI creation, so the claim is the last step before the success response, with full rollback on failure — see Phase 2). The RPC is re-entrant for the same order+promo pair (checkout replays must not double-count) and returns `false` when the order id already holds a live claim for a *different* promo (one code per order). `markPaid` → `redeemed` (settle is conditional: it reports whether `redeemed` was actually recorded, and a late-paid settle on an already-`released` row triggers re-claim/reconciliation — see Phase 1); `releaseHold`, the cron expiry sweep, and `releaseSale`'s pending→refunded branch → `released`. Refund of a **paid** order: stays `redeemed`.
6. **Fail closed:** a checkout POST carrying a code that no longer validates returns 400 `{ error: 'invalid_promo' }` (or 409 `{ error: 'promo_exhausted' }`) — it never silently charges full price. Operator deactivation mid-checkout therefore surfaces as a clear client error, and the client drops the code.
7. **Preview vs. authority:** `POST /api/promo/validate` gives the cart page a rate-limited preview (discount for the current cart+currency); `/api/checkout` re-validates authoritatively. The client only ever sends the code string.
8. **Newsletter:** at most one promo may be flagged `newsletter_welcome` (partial unique index); the welcome email is sent best-effort after confirm — failure logs but never breaks the 302 redirect. Shared campaign code, not per-subscriber unique codes.
9. **Analytics:** client fires `site_engagement`/`engagement_type: 'promo_apply'` (with `result`, `code`, `track`); `coupon` param added to client `begin_checkout`/`purchase` and to the server GA4 MP payload; server GA4 `value` becomes `(subtotal − discount)/100`; Meta CAPI needs no change (it already uses `order.total`, which is post-discount). Existing dedup (deterministic `purchase-<pi>` event id, `conversions_sent_at` claim) is untouched.
10. **No caching:** promo reads hit Supabase per invocation (same rule as catalog/print-pricing — the deployed OpenNext config has no persistent tag cache; never wrap in `unstable_cache`).

## Phase index

Execute in order; each phase leaves the branch green (`npm run lint && npm run typecheck && npm run test`).

| # | Prompt file | Delivers |
|---|---|---|
| 1 | `2026-08-30-promo-codes-phase-1-domain.md` | Migration (`promo_codes`, `promo_redemptions`, RPCs) + `src/lib/promo.ts` domain logic + unit tests |
| 2 | `2026-08-30-promo-codes-phase-2-checkout-server.md` | `/api/checkout` accepts + applies codes; order columns; PI metadata; webhook finalize/release; cron release; invoice discount line |
| 3 | `2026-08-30-promo-codes-phase-3-cart-ui.md` | `POST /api/promo/validate` + CartView promo entry/discount row for both tracks + i18n + hermetic e2e |
| 4 | `2026-08-30-promo-codes-phase-4-admin.md` | `/admin/promotions` screen + `/api/admin/promotions` CRUD/toggle + utilization stats + audit log + nav |
| 5 | `2026-08-30-promo-codes-phase-5-newsletter-email.md` | Welcome email with promo after double-opt-in confirm + admin `newsletter_welcome` flag ("new silter" resolution) |
| 6 | `2026-08-30-promo-codes-phase-6-analytics.md` | Client + server analytics: promo events, `coupon` on begin_checkout/purchase, GA4 MP value fix |
| 7 | `2026-08-30-promo-codes-phase-7-verification.md` | Full verification matrix, docs (`docs/promo-codes.md` runbook, AGENTS.md, STATUS.md), final report |

## Global constraints (apply to every phase)

- Build stays `next build --webpack` — never Turbopack (production-down rule).
- Monetary values are integers in minor units server-side (grosze/euro-cents/pence); analytics uses major units.
- No secrets client-side; all promo validation/mutation goes through server routes. Admin routes rely on the existing Cloudflare Access gate — do not add a second auth layer.
- API errors follow `NextResponse.json({ error: reason }, { status })` with snake_case reason codes.
- Migrations: additive only; new RPCs follow house style (invoker rights, `set search_path = public, pg_temp`, revoke-then-grant as in `20260813170000_harden_rpc_and_catalog.sql`). Remember: merge to main auto-applies migrations to **prod** before the worker deploys.
- ⚠️ Local `.env.local`/`.dev.vars` point at the **production** Supabase project (memory note 2026-08-04). Never insert test promo rows against it from local runs; unit tests mock Supabase, e2e stays hermetic.
- Windows dev quirks: 4 pre-existing local-only vitest failures may appear — diff against `main`'s results before chasing; e2e needs a manual server on :3210 + `PLAYWRIGHT_BASE_URL` (port 3000 is squatted); delete `playwright-report/` before `npm run lint`.
- Worktree gotcha: `.next` inside worktrees is a symlink git can't ignore — never `git add -A` blindly; stage by explicit path.
- Git safety: commit frequently on `feat/promo-codes` **in the worktree only**; never push to `main`; do not open a PR until Phase 7's verification passes. PR title `feat: promo codes across both checkout tracks` (release-please minor bump).
- No production/external actions: no live Stripe objects, no real customer emails, no prod DB writes, no live provider config changes.

## Execution protocol (worktree + self-review loops)

1. **Setup (once):** create the worktree/branch via superpowers:using-git-worktrees (`feat/promo-codes` off current `main`). Verify `npm run test` baseline before writing code (record any pre-existing Windows failures).
2. **Per phase:** open the phase prompt, execute its checkboxed tasks in order (TDD where the prompt specifies tests), committing after each green step with a conventional-commit message.
3. **Self-review loop (end of every phase, mandatory):**
   a. Run `npm run lint && npm run typecheck && npm run test` and read the actual output.
   b. Re-read the phase's full diff (`git diff main...HEAD -- <phase files>`) with fresh, adversarial eyes: check against this master's "Locked architecture decisions", the phase's acceptance checklist, and the repo conventions (minor units, error shapes, no client secrets, no caching).
   c. Fix everything found, re-run checks, commit fixes as `fix:`/`refactor:` commits.
   d. Only then proceed to the next phase. If a locked decision proves wrong in practice, stop and update the master plan file first (commit the plan change), then continue.
4. **Phase 7** is the integration gate: run the whole verification matrix, write docs, and produce the final report distinguishing verified results from anything environment-blocked.

## Success criteria

1. Promo codes apply correctly in both ceramic and print checkouts; the Stripe PI amount, `orders` row, emails, and invoice all reflect the discount consistently.
2. All validation/discount math is server-side; client tampering with amounts is impossible by construction.
3. Operators can create/configure/activate/deactivate/inspect promotions and see real utilization stats (pending/redeemed/released counts, discount given, attributed revenue) at `/admin/promotions`.
4. A new newsletter subscriber receives the flagged promo in a welcome email after confirm; when no promo is flagged, behavior is exactly today's.
5. GA4 shows promo application attempts, `coupon` on begin_checkout/purchase (client + server MP), with no new duplicate events.
6. Existing checkout, inventory, tax, shipping, payment, and fulfilment behavior is unchanged when no code is supplied (regression-tested).
7. `npm run lint && npm run typecheck && npm run test` green; new hermetic `@ci` e2e passes; anything environment-blocked (live Stripe, real emails, prod webhook) is explicitly listed as unverified in the final report.
8. No production/external side effects were performed.

## Known open items to carry into the final report

- The "new silter" → newsletter interpretation needs one-line operator confirmation before enabling the `newsletter_welcome` flag in production.
- `@destructive` e2e specs (real Stripe test-mode purchase with a promo) can only run in the operator-approved e2e-edge environment — list as pending if not run.
- The `orders.discount` column changes what `reconcile-refunds` / admin refund flows see as `total`; Phase 2 verifies refund amount math but a live refund of a discounted order should be watched on first occurrence.
