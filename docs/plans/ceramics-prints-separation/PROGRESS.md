# Ceramics ⇄ prints separation — execution progress

One entry per domain: decisions, files touched, tests, surprises. Consult before starting each domain.

## 01 — Refund lifecycle (DONE)

**Prodigi API shape (verified against https://www.prodigi.com/print-api/docs/reference/):**
- `GET /v4.0/orders/{id}/actions` → `{ outcome: "Ok", cancel: { isAvailable: "Yes"|"No" }, ... }`
- `POST /v4.0/orders/{id}/actions/cancel` → `{ outcome: "Cancelled"|"FailedToCancel"|"ActionNotAvailable", order: {...} }` — order stages are `InProgress`/`Complete`/`Cancelled`; cancel only available before fulfilment.
- Implementation checks `actions.cancel.isAvailable === 'Yes'` first (so `cancelOrder` is never called on a shipped order), then requires `outcome === 'Cancelled'`; any other outcome falls through to the alert.

**Decisions:**
- `prodigi_status_stage` keeps **raw Prodigi casing** (`'Cancelled'`, not `'cancelled'`) — matches processJob (`'InProgress'`) and the callback upsert convention.
- Alert idempotency across the two call sites (admin refund + webhook releaseSale) needed a claim column → migration `20260707120000_prodigi_orders_cancel_alert.sql` adds `prodigi_orders.cancel_alerted_at`; CAS-claimed before alerting (same pattern as `*_email_sent_at`). **Applied to production** (`20260707102056` via Supabase MCP, 2026-07-07).
- Studio alert email is Polish-only, matching the existing studio email convention (label/new-order emails).
- Helper never throws (Sentry captures every failure path) so a Prodigi hiccup can't 5xx the refund webhook into a retry loop.

**Surprise:** `process-job.ts` already had the "order not paid → failed_action_required" guard (plan step 4) — it predates this work. Only strengthened its test to assert `postOrder` is never called.

**Files:** `src/server/prodigi/types.ts` (+2 response types), `src/server/prodigi/client.ts` (+`getOrderActions`, `cancelOrder`), `src/server/fulfilment/cancel-print.ts` (new helper), `src/lib/email.ts` (+`buildPrintRefundAlertEmail`/`emailPrintRefundAlertToStudio`), `src/app/api/stripe/webhook/route.ts` (releaseSale wire-in after CAS), `src/app/api/admin/refund/route.ts` (wire-in after refund create), migration above.

**Tests:** `src/server/fulfilment/cancel-print.test.ts` (10 new), webhook `route.test.ts` (+5: full refund / replay / partial / dispute lost / dispute won), `process-job.test.ts` (+1 assertion). Full suite 637 green, lint clean, build green.

**Note:** a stale `.next` dir in the worktree made `next build` fail with a workStore invariant — `rm -rf .next` fixed it; not related to any code change.

## 03 — Returns guard (DONE)

**Decision:** kept the DI style — new `CreateReturnDeps.hasCeramicItems(orderId)` dep, checked after the `already_returned` rung of the eligibility ladder. Route wires it via the existing `countCeramicOrderItems` (`variant IS NULL`); a count error **throws** (→ 500) rather than reading as "no ceramics", so a DB hiccup can't 404 a legitimately returnable order.

**Files:** `src/lib/return.ts`, `src/app/api/returns/route.ts`, `src/lib/return.test.ts` (+2: print-only → `not_eligible`, mixed-with-ceramic stays eligible; the 7 existing ceramic tests pass unchanged with the dep defaulting to `true`).

**Verified:** return tests 9/9, full suite 639, lint clean, build green. No surprises.

## 02 — Admin (DONE)

**Decisions:**
- Guard (F2): 409 with a Polish human message in `error` (`…wysyłkę realizuje Prodigi, nie InPost.`) — matches the route's existing convention; the admin UI (`FulfillmentActions`) renders `data.error` directly, so a machine code would surface raw to the user. Count failure → 500, never "reads as print-only".
- Dashboard (F3): added `variant` to both `order_items` joins in `data.ts`; new `isPrintOnly()` (items non-empty && every variant non-null). New `FulfillmentStage` value `'prodigi'` returned first from `computeFulfillmentStage`; queue filter unchanged so prints drop out of the InPost queue automatically. Stage label "Prodigi (druk)" added to both STAGE_LABEL maps (Record type forces exhaustiveness); `FulfillmentActions` shows muted "Wysyłka: Prodigi" (no buttons). Skipped the nice-to-have Prodigi stage readout from `prodigi_orders` — plan's minimum bar is exclusion; revisit only if the studio asks.
- `getKpis` now joins items (was `withItems: false`) because the KPI exclusion needs the discriminator; dataset tiny, join cheap. `awaitingFulfillment` excludes print-only; print orders still count in `ordersByStatus`/revenue.

**Files:** `src/lib/admin/data.ts`, `src/lib/admin/fulfillment.ts`, `src/app/api/admin/create-shipment/route.ts`, `src/app/admin/fulfillment/page.tsx`, `src/app/admin/fulfillment/[id]/page.tsx`, `src/app/admin/fulfillment/FulfillmentActions.tsx`.

**Tests:** create-shipment route (+1 print-only 409, helper mock extended with the order_items count chain), fulfillment (+2 stage tests, +1 queue-exclusion row), new `data.test.ts` (isPrintOnly + KPI exclusion). Full suite 645, lint clean, build green.

## 04 — Emails (DONE)

**Decisions:**
- F7: webhook studio caller selects `variant` and maps print items to `{ ...variant, prodigiSku }` via `PRODIGI_SKU_MAP[variantKey(...)]` (fallback `'—'` for an unknown key — can't happen for a validated order). The `.mjs` reconcile script can't import TS, so it derives the SKU from the map's structure (`GLOBAL-{FAP|CFP|CFPM}-{inches}`) with a `ponytail:` sync note, and renders a PL-only variant line.
- F5: `buildOrderConfirmationEmail`/`emailOrderConfirmationToCustomer` take `kind?: 'ceramic' | 'print'` (default ceramic → all existing callers unchanged). New `I18N_ORDER_CONFIRMATION_PRINT` map (pl/en/es/de): Prodigi on-demand production, 2–5 business days, EU/UK courier, tracking email promised — no InPost/Poland/locker text. Webhook derives kind from the (now variant-aware) item rows: print copy only when ALL items are prints.
- F6: new `buildPrintShippingConfirmation` + `emailPrintShippingConfirmationToCustomer` — reuses the existing 4-locale `I18N` shipping strings; carrier tracking number + URL button; **no returns block** (prints not returnable per 03) and no locker language. Sent from `handleProdigiCallback` when `localStatus === 'shipped'`, claim-once via new `prodigi_orders.shipping_email_sent_at` (migration `20260707130000`), order email loaded **before** claim (no leak on missing email), 3× bounded retry + Sentry on final failure (Stripe webhook parity — Prodigi won't redeliver the same event id after HTTP 200), claim released (CAS on own timestamp) only after retries exhausted. Best-effort — callback still completes.
- Prodigi `shipments[]` shape verified against the docs: `{ carrier: { name, service }, tracking: { number, url }, dispatchDate, status }`; added `ProdigiShipment` to types.
- Route test needed `@/server/fulfilment/enqueue` mocked once print items started flowing through the succeeded path.
- **Deploy ordering:** apply migration `20260707130000_prodigi_orders_shipping_email.sql` to prod Supabase **before** the Workers deploy that ships this branch — the callback UPDATEs `shipping_email_sent_at` on first Complete event; a missing column fails the claim silently (best-effort) and customers never get tracking emails.
- `reconcile-orders.mjs --emails` now mirrors webhook kind detection (print copy when all items have `variant`).

**Known gap (follow-up):** no `--print-shipping` reconcile path yet for missed Prodigi tracking emails (`prodigi_status_stage = Complete` AND `shipping_email_sent_at IS NULL`). Sentry alert + manual replay is the backstop until then.

**Files:** `src/lib/email.ts`, `src/app/api/stripe/webhook/route.ts`, `src/server/prodigi/callbacks.ts`, `src/server/prodigi/types.ts`, `scripts/reconcile-orders.mjs`, migration `20260707130000_prodigi_orders_shipping_email.sql`.

**Tests:** email.test.ts (+7: studio SKU render, print copy ×4 locales, ceramic default, print shipping builder ×3), webhook route.test.ts (+2: print studio payload + print kind; ceramic kind), new `callbacks.test.ts` (6: send-once, claim-taken replay, done-event replay, non-shipped stage, 3× retry + claim release on failure, no claim when email missing). Full suite 661, lint clean, script `node --check` OK, build green.

## 05 — Architecture (DONE)

**Decisions:**
- Migration `20260707140000_orders_fulfilment_type.sql`: add column → backfill (`odbior→pickup`, any `variant IS NOT NULL` item → `prodigi`, else `inpost`) → `DEFAULT 'inpost'` → `NOT NULL` → CHECK. The DEFAULT exists only to survive the migrate-before-deploy window (old code inserting without the column); it slightly mislabels pickup/print orders placed in that window — fix by re-running the backfill UPDATE without the null guard. At this store's volume the window is minutes and near-zero rows.
- Checkout writes `fulfilment_type` on insert (`pickup`/`prodigi`/`inpost` from `method` + `hasPrints`) and on Stripe PI metadata. Skipped the `delivery_method` CHECK (plan marked optional; legacy rows unaudited — not worth the risk).
- **Consumer switch: none.** 02/03/04 shipped first on `order_items.variant`, tested and correct; the plan explicitly allows either discriminator and says don't chase migration. Rewriting tested consumers for cosmetic parity fails the ponytail test. `fulfilment_type` is now available for future consumers.
- Migration `20260707150000_drop_pod_variant_id.sql`: re-grep confirmed zero references outside the creating migration.
- F12 guard: `privateSaleToken && hasPrints → 400 private_sale_prints_unsupported`, placed before any reservation. CartView blocks pay client-side too. Declared in AGENTS.md (private-sale bullet + API error contract).

**Migration verified against a real Postgres** (throwaway `supabase/postgres:17.6` docker container, minimal schema slice): backfill produced inpost/prodigi/pickup/inpost for the four seed orders; CHECK rejected `'fedex'`; column-omitted insert got the `'inpost'` default; `pod_variant_id` dropped. No local Supabase stack was running — the prod DB still needs `supabase db push` (or dashboard SQL) at deploy time. Deploy gate documented in `docs/cloudflare-deployment.md`.

**Files:** two migrations, `src/app/api/checkout/route.ts`, `src/components/shop/CartView.tsx`, `AGENTS.md`, `docs/cloudflare-deployment.md`, `messages/{pl,en,es,de}.json`, `src/app/api/checkout/route.test.ts`.

**Tests:** checkout route +5 (fulfilment_type pickup/inpost/paczkomat/prodigi + PI metadata; private-sale×prints 400 with no reserve/PI/insert). Full suite 674, lint clean, build green.

## 06 — PDP/UX (DONE)

**Decisions:**
- F10: `AddToCartButton`, `Lightbox`, and `ProductTile` mirror `PrintConfigurator`'s guard — `cartHasPrints = ids.some(isPrintToken)`; when true (and the ceramic isn't already in the cart) they block add. PDP/lightbox show disabled button + `ceramic.mixedCart` (symmetric to `print.mixedCart`; `cart.mixedNotice` stays on the cart page only). `data-testid="ceramic-add"` on every AddToCartButton/Lightbox variant for E2E.
- Q7: ceramic delivery section in `CartView` shows `delivery.plOnly` once at the top of delivery fields when `!hasPrints` — visible for all ceramic methods (paczkomat/kurier/odbior), not kurier-only. Copy only, PL enforcement stays server-side. New `.cart-pl-only` style (muted 13px, matches notice typography).
- F13: no price change. `print_multi_frame_flat_shipping` `console.warn` fires after `shipMinor` is computed, with `framed_count`, `item_count`, `charge_currency`, `shipping_minor`, `has_framed`, and `country`. Marked `ponytail:`. **Revisit trigger:** implement Prodigi `POST /quotes` only when prod logs/margins show multi-frame orders materially under-charged.

**No component test harness exists in this repo** (no *.test.tsx, no testing-library) — as the plan anticipated; the F10 guard is proven by `e2e/mixed-cart.spec.ts` in domain 07.

**Files:** `src/components/shop/AddToCartButton.tsx`, `src/components/shop/Lightbox.tsx`, `src/components/shop/ProductTile.tsx`, `src/components/shop/CartView.tsx`, `src/styles/site.css`, `messages/{pl,en,es,de}.json`, `src/app/api/checkout/route.ts` (log only).

**Verified:** full suite 673, lint clean, build green; locale JSON validated via node require.

## 07 — Regression & E2E (DONE — one E2E test deferred to the deploy gate)

**Unit/integration added (all green, suite 665 → 702):**
- Checkout print matrix (`checkout/route.test.ts` +12): paczkomat/odbior/no-address/US/CH → 400; framed DE → 200 with `printShippingOf` shipping and the InPost price list never consulted; loose DE differs; print PL → 200; ceramic DE → 400; mixed_cart → 400 pre-reservation; EUR + GBP shipping minor units via `currency_pref` cookie.
- Webhook routing (`stripe/webhook/route.test.ts` +3): ceramic → InPost only; print → `enqueueProdigi` only; defensive mixed → both.
- New `server/fulfilment/enqueue.test.ts` (6): stable idempotency key, conflict re-select + resend, missing-row throw, upsert-failure throw, queue-send throw, inline `processJob` fallback when `FULFILMENT_QUEUE` is absent.
- `server/prodigi/callbacks.test.ts` +7: 400 shapes, in-flight lease short-circuit, InProduction → `in_production` job mapping, terminal status never downgraded, unknown-order → 500 + claim released, re-fetch failure → 500 + claim released.
- New `api/webhooks/prodigi/[token]/route.test.ts` (4): 401 bad token (handler untouched), 400 bad JSON, delegation, `{ error }` mapping.
- `process-job.test.ts` +2: happy path (claim → postOrder → prodigi_orders upsert `InProgress` → `fulfilment_submitted`, attempts+1); 409 duplicate recovery via `e.body.order.id`.
- New `api/inpost/webhook/route.test.ts` (6): 401/400, ceramic confirmed → status mirror + label + tracking emails once, non-confirmed → no emails, replay → no duplicates, unknown shipment (the print case — prints never carry `inpost_shipment_id`) → 200 + zero emails.

**E2E:**
- New `e2e/mixed-cart.spec.ts` (@ci) — print blocks ceramic PDP add (F10 guard), tile-built mixed cart shows notice + disabled checkout, removing the print re-arms ceramic checkout. **Passes** against the hermetic local build (`PLAYWRIGHT_BASE_URL=http://localhost:3000`, env from the repo-root `.dev.vars`/`.env.local` — copied into the worktree, gitignored).
- New `e2e/print-purchase.spec.ts`: `@ci` courier-only cart UI (no paczkomat/odbiór/Geowidget, country select present, PL-only note absent); `@checkout-edge @destructive` payment test deferred — needs a deployed preview with Stripe webhooks reachable and `PRODIGI_ENV=sandbox`. Run at the release gate: `PLAYWRIGHT_BASE_URL=<preview> E2E_DESTRUCTIVE=1 E2E_PRODIGI_SANDBOX=1 npx playwright test e2e/print-purchase.spec.ts --grep @destructive`.
- Extended `e2e/checkout-409.spec.ts`: asserts the country selector is **absent** on the ceramic path. Also fixed a pre-existing break: the spec hardcoded `talerzyki`, which is now fully sold out in prod (verified: 14/14 `data-sold="true"`) — picks are now stock-aware over six families.
- Full local @ci run: **8/8 pass** (needed `npx playwright install chromium` + a rebuild with `.env.local` present so `NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN` is baked in — without it the Geowidget helper hits its documented environment blocker).

**Remaining for the release gate (not doable from this session):** apply the four migrations across domains to prod Supabase (`20260707120000`, `20260707130000`, `20260707140000`, `20260707150000`), deploy, then run `npm run test:e2e` (@ci) and the destructive print-purchase spec against the preview.

## All domains on main (2026-07-07)

**Landings:** PR [#117](https://github.com/konradciok/ceramics-drop/pull/117) (domains 05–07 → `main`), PR [#118](https://github.com/konradciok/ceramics-drop/pull/118) (domain 01 follow-ups → `main`), commit `cd72237` (mixed-cart E2E fix — tile guard from 06 blocks tile add, spec seeds cart via localStorage).

**Prod Supabase:** all four Jul-7 migrations verified applied (`prodigi_orders_cancel_alert`, `prodigi_orders_shipping_email`, `orders_fulfilment_type`, `drop_pod_variant_id`).

**Deploy:** Cloudflare Workers Builds succeeded for `main` @ `d5a1c9a` (2026-07-07).

**E2E:** `npm run test:e2e` (@ci) — **9/9 pass** against `https://anna-ciok.studio`. Destructive print-purchase spec still manual: `PLAYWRIGHT_BASE_URL=<preview> E2E_DESTRUCTIVE=1 E2E_PRODIGI_SANDBOX=1 npx playwright test e2e/print-purchase.spec.ts --grep @destructive`.
