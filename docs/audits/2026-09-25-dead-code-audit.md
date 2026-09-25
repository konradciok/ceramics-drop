# Dead-code audit — 2026-09-25

Repository-wide dead-code audit performed by four parallel read-only sub-agents,
each scoped to one domain (frontend/storefront UI, API routes & server logic,
database/scripts/infra, dependencies/tests/config), then synthesized into this
report. No files were modified as part of the audit itself; this is a findings
document only. Three of the four agents independently converged on the same
returns-flow dead cluster, and two independently converged on the same stale
CMS-API documentation claim — cross-validation from independent passes, not a
single agent's opinion.

## Executive summary

- **Scope investigated:** ~150 frontend files (components/pages/hooks/store) +
  743 i18n keys × 4 locales; 41 API routes + ~870 exported symbols across
  `src/lib/**` and `src/server/**`; 79 DB migrations, 87 script files, 17
  contract files, 6 CI workflows, 203 docs files; 32 npm dependencies, ~295
  test files, 6 config files, 68 documented env vars.
- **Confirmed dead:** 14 items/clusters (spanning ~20 files: TS modules,
  their tests, CSS selectors, i18n keys, env vars).
- **Probably dead:** 8 items (i18n keys, one zod schema, a "Phase 0" print
  manifest module, and 4 orphaned CSS selectors) — each needs a quick owner
  check before deletion, not a deep investigation.
- **Suspicious / needs verification:** 4 items, all low-risk (dev-only
  scripts and doc status ambiguity), zero payment/fulfilment-path risk.
- **Dead feature clusters:** 3 major (customer-initiated return shipments,
  legacy `Product[]`-based analytics events, a superseded print-derivative
  compositor) + 1 medium (pre-CMS print-PDP section copy) + 1 low-confidence
  ("Phase 0" print-asset manifest code).
- **Dead API endpoints:** **0** of 41. `/api/returns` looks dead by traffic
  (no caller) but is a deliberate `410 Gone` stub — the orphaned code is
  *behind* it, not the route itself.
- **Removable dependencies:** **0**. Every one of the 32 npm packages has a
  live call site or `npm run` script invocation.
- **Not dead-code, but a real finding:** this repo's own architecture doc
  (`AGENTS.md`) and one "active"-tagged doc (`docs/cms-api-s1-handoff.md`)
  are now materially stale in ~9 places (detailed in [§ Documentation
  drift](#documentation-drift-found-during-the-audit)), and roughly
  **20–25 shipped plan/spec files** sit outside `docs/archive/` in violation
  of this repo's own stated lifecycle rule. Neither is "dead code" per se,
  but both actively risk misleading the next audit or agent session — see
  the recommendation at the end.
- **Coverage caveat:** the database/scripts agent had no live-DB access, so
  every DB-object finding below is evidence-weighted accordingly (marked
  SUSPICIOUS rather than CONFIRMED). CSS "dead selector" findings are
  best-effort (absence of a class name in `.tsx` is strong but not perfect
  evidence given dynamic class construction, which was checked case-by-case).

---

## Confirmed dead code

| # | Location | Symbol/Type | Reason | Confidence |
|---|---|---|---|---|
| 1 | `src/lib/return.ts` (whole file) | `createOrderReturn`, `CreateReturnDeps`, `CreateReturnResult` | Orphaned when `POST /api/returns` was gutted to a static `410` stub in commit `8305bd28` (PR #295, 2026-09-09). Zero callers outside its own test. | High |
| 2 | `src/lib/return.test.ts` | Test file | Tests item 1. | High |
| 3 | `src/lib/shipx.ts` (partial) | `buildReturnShipmentPayload()`, `OrderForReturn`, `StudioReturnConfig` (+ their test cases in `shipx.test.ts`) | Only ever called by the now-dead `return.ts`. Rest of `shipx.ts` (`validateDelivery()` etc.) is live and untouched. | High |
| 4 | `src/components/shop/return-status.ts` + `.test.ts` | `returnStatusMessageKey`, `ReturnStatusKey` | Mapped `/api/returns` HTTP status → UI copy; its only caller, `ReturnRequestForm.tsx`, was rewritten in the same PR #295 commit to a static `mailto:` link. | High |
| 5 | `src/styles/site.css:1278-1279` | `.return-msg`, `.return-msg-error`, `.return-msg-ineligible` | Styled the removed status-message `<p>` from the old return form. | High |
| 6 | `messages/{pl,en,es,de}.json` | `returns.label`, `returns.success`, `returns.ineligible`, `returns.unavailable`, `returns.rateLimited`, `returns.error`, `returns.instructions` | Only read via the removed dynamic-status branch of `ReturnRequestForm.tsx`. (Note: `returns.eyebrow/heading/intro/moreInfo` on `/zwrot` are **different keys, still live** — don't conflate.) | High |
| 7 | `.env.example` + `AGENTS.md` | `STUDIO_RETURN_FIRST_NAME`, `_LAST_NAME`, `_EMAIL`, `_PHONE`, `_ADDRESS_STREET`, `_ADDRESS_BUILDING`, `_ADDRESS_CITY`, `_ADDRESS_POSTAL`, `_POINT` (9 vars) | Constructed a `StudioReturnConfig` object nothing builds anymore. Zero `process.env`/`env.` reads anywhere in `src/`, `scripts/`, `worker.ts`. | High |
| 8 | `scripts/lib/compose-master.ts` + `.test.ts` | `composeDerivative(artworkPath, signaturePath, canvas, format, config)` (positional-arg, file-path-based) | Superseded by `scripts/lib/prepare-derivatives.ts`'s differently-shaped `composeDerivative(input: ComposeInput)` (object-arg), which is what `scripts/print-assets-prepare.ts` (backs `npm run print-assets:prepare`) actually imports. Confirmed exactly one importer repo-wide: its own test. | High |
| 9 | `src/lib/analytics.ts` | `buildViewCartEvent()`, `buildBeginCheckoutEvent()`, `buildPurchaseEvent()` | Legacy `Product[]`-based event builders. Superseded by the `*FromItems()` family (added to support mixed ceramic+print+gift-card carts). Zero callers anywhere. | High |
| 10 | `src/lib/checkout-analytics.ts` | `pushCheckoutStarted()`, `pushConfirmedPurchase()` | Only callers of item 9's dead builders. Live path is `pushCheckoutStartedItemsOnce`/`pushConfirmedPurchaseByIdsOnce`, confirmed called from `CartView.tsx` and `/koszyk/return/page.tsx`. | High |
| 11 | `src/lib/pricing.ts` | `priceOf(product, locale)` | `AGENTS.md` documents this as *the* convention, but the actual codebase uses currency-cookie-driven `priceOfCurrency()` everywhere (15 files). Zero callers outside its own test. | High |
| 12 | `src/lib/cms/schemas.ts` | `isCmsLocale()` | Every real locale check inlines `CMS_LOCALES.includes(...)` directly instead. Sibling `isCmsKind()` (2 callers) is fine, don't remove that. | High |
| 13 | `src/lib/email-layout.ts` | `emailFieldLabel()` | Zero callers anywhere, including within its own file; sibling helpers (`emailMutedParagraph`, `emailButton`) are used. | High |
| 14 | `src/server/cms-api/shipping-rates-validation.ts` | `internationalRatesOf()`, `domesticRatesOf()` | The CMS API shipping-rates feature itself is live and fully wired; every real caller (including this file's own test) inlines the equivalent check instead of calling these convenience narrowers. | High |

---

## Probably dead code

| # | Location | Symbol/Type | Reason | What to verify | Confidence |
|---|---|---|---|---|---|
| 15 | `messages/{pl,en,es,de}.json` | `print.sectionDetails`, `print.technique`, `print.sectionEdition`, `print.editionOpen`, `print.sectionDelivery`, `print.deliveryNote`, `print.sectionCare`, `print.careNote` | Pre-2026-08-10 static print-PDP copy, superseded by the CMS-driven `printPdp.accordion*` fields (PR #237) read from the `page:print-pdp` document. Only referenced from historical plan docs, never from `.ts`/`.tsx`. | The `page:print-pdp` CMS document is also edited from the separate `cms-ceramics` repo — confirm nothing there still expects these fallback keys before deleting. | High |
| 16 | `src/lib/catalog/schemas.ts` | `CERAMIC_CATEGORY` (zod enum) | Not wired into `productUpdateSchema` in the same file; the file's own comment defers category-move to "Stage 4c." Looks like unused forward-scaffolding rather than a refactor leftover. | Ask whoever owns the Stage 4c catalog-editor work whether this is intentional scaffolding (keep) or truly abandoned (delete). | Medium |
| 17 | `src/lib/print-assets-prepare.ts` | `prepareManifestSchema` (union export) | Its two constituent schemas ARE used via `.safeParse()`; the union itself has zero callers anywhere in this repo. | Low risk (CLI/operator tooling, not payment path) but verify no external consumer (e.g. `cms-ceramics`) imports it before deleting. | Medium-High |
| 18 | `src/lib/print-composition.ts` | `buildAssetManifest()`, `parseCompositionConfig()`, `RENDERER_VERSION` (`'1.0.0'`) | File header says "Phase 0 extraction." Real consumers only import `composeLayout` + types from this file. A newer `COMPOSE_RENDERER_VERSION = '3.0.0'` in `print-assets-prepare.ts` is what's actually checked at runtime — this older manifest path looks superseded. | Verify with the print-asset-pipeline owner (`docs/plans/print-asset-pipeline.md`) — low risk, build-tooling only. | Medium-High |
| 19 | `src/styles/site.css:1249` + `src/styles/motion.css:20` | `.reveal--scale` | Modifier for the pre-PSTR "hero-beat" scroll-parallax band. `.hero-beat` itself no longer exists anywhere (superseded by the 2026-08-28 PSTR hero, PR #263/#265). Base `.reveal` is still widely used; `--scale` is never appended, including via dynamic template-literal construction (checked). | Confirm with design owner before a future hero iteration might reintroduce it. | Medium-High |
| 20 | `src/styles/site.css:1024-1025` | `.fade-in`, `.fade-in.visible` | Present since the original Next.js scaffold commit; `git log -S"fade-in"` shows it was never wired to a React `className`, only referenced defensively in the `prefers-reduced-motion` reset. | — | Medium |
| 21 | `src/styles/site.css:1537-1538` | `.showroom-card-price`, `.showroom-card-sold` | The current `ShowroomScreen.tsx` (post PR #295) renders only media + eyebrow + name — no price, no sold badge. | Confirm the price/sold badge isn't meant to return to the showroom card design. | Medium |
| 22 | `src/styles/site.css:576,580,583` | `.shop-nav-track.has-filter` compound selectors | No current component combines `.shop-nav-track` (only in `PrintCollectionScreen.tsx`, no filter) with `<StatusFilter>` (only in `CollectionScreen.tsx`, no `.shop-nav-track`). | Confirm no near-term plan reunites jump-nav + filter on one screen. | Medium |

---

## Suspicious / needs verification

| # | Location | Type | Reason | Risk | Recommendation |
|---|---|---|---|---|---|
| 23 | `scripts/test-active-drop-postgres.mjs` | Orphaned utility script | Zero doc references (unlike its sibling `test-gift-card-postgres.mjs`, documented in `docs/gift-card-balance-runbook.md`). No `package.json` entry, no CI reference. Single commit, PR #296, never touched since. | None — local dev-only tool, not reachable from any request path. | Document it alongside its sibling, or delete if the `ceramic_drop_conflicts` RPC no longer needs manual Postgres verification. |
| 24 | `docs/plans/staging-plan.md` | Doc describing possibly-never-built infra | Describes adding `env.staging` to `wrangler.jsonc`; current config has only `env.preview`, and `staging.anna-ciok.studio` appears nowhere in code/config. | None (doc-only). | Confirm with the operator whether a staging env exists outside this repo's tracked config; if abandoned, mark it explicitly or archive. |
| 25 | `docs/plans/2026-storefront-upgrade.md` — Spec C (PDP Transparency + View-Transition Morph) | Never-implemented spec | Zero trace of view-transition/morph terms anywhere in `src/`. Parent doc's rollout-status table was never updated to reflect this. | None (doc-only). | Mark abandoned in the doc, or archive the child plan (`docs/superpowers/plans/…-pdp-transparency-morph-plan.md`). |
| 26 | `docs/plans/2026-storefront-upgrade.md` — Spec D hero half | Superseded spec | Spec D's shrinking-header half shipped and is live (`motion.css:32`); its hero half was superseded by an entirely different design (the PSTR full-bleed CMS hero, PR #263/#262), not this spec. | None (doc-only). | Mark hero-half "superseded by PSTR redesign" in the doc's status table. |

**Note:** the database/infra agent additionally checked all 36 DB tables and
all 52 RPCs defined in migrations against application-code callers, and found
**zero** with no legitimate caller (a handful are called only from trigger
bodies / other SQL functions, which is expected internal factoring, not dead
code — see False Positives). No DB-object findings made it into this section
because none looked orphaned even at SUSPICIOUS confidence.

---

## Dead features / clusters

### Cluster 1 — Customer-initiated return shipments (retired 2026-09-09, PR #295)
The **route itself is intentionally kept** as a `410 Gone` stub pointing
customers to a contact email — that part is correct and should not change.
Everything *behind* it is now dead weight:
- `src/lib/return.ts` (whole file) + test
- `src/lib/shipx.ts`'s return-only exports (`buildReturnShipmentPayload`,
  `OrderForReturn`, `StudioReturnConfig`) + their test cases
- `src/components/shop/return-status.ts` + test
- CSS: `.return-msg*` (3 selectors)
- i18n: 7 `returns.*` keys × 4 locales
- 9 `STUDIO_RETURN_*` env vars (`.env.example` + `AGENTS.md`)
- Stale docs: `AGENTS.md`'s `/api/returns` description, `docs/cloudflare-deployment.md`'s "all required, or `POST /api/returns` returns 503" claim (both now factually wrong — the route always 410s)

**Explicitly NOT part of this cluster** (verified live, don't touch):
`src/lib/return-rate-limit.ts`'s `createReturnRateLimiter` survived the
retirement — it's now wrapped by `src/lib/auth/rate-limit.ts` as
`createAuthRateLimiter()` and backs `/api/auth/login`'s rate limiter.
`emailReturnLabel` in `src/lib/email.ts` is a same-named but unrelated live
feature (outbound studio→customer shipping labels via `/api/inpost/webhook`).

### Cluster 2 — Legacy `Product[]`-based analytics event builders
`buildViewCartEvent`, `buildBeginCheckoutEvent`, `buildPurchaseEvent`
(`src/lib/analytics.ts`) and their wrappers `pushCheckoutStarted`,
`pushConfirmedPurchase` (`src/lib/checkout-analytics.ts`). Superseded when
the codebase moved to a unified `AnalyticsItem[]`-based model (`*FromItems`)
to support mixed ceramic+print+gift-card carts in one dataLayer push. Left in
place, still unit-tested, invisible to CI, never called by real code.

### Cluster 3 — Superseded print-derivative compositor
`scripts/lib/compose-master.ts` (+ test) — the original file-path-based Sharp
compositor from the 2026-07-15 asset-pipeline plan, replaced by
`scripts/lib/prepare-derivatives.ts`'s object-arg version, which is what the
live `npm run print-assets:prepare` script actually calls.

### Cluster 4 (medium confidence) — Pre-CMS print-PDP section copy
The 8 `print.section*`/`technique`/`editionOpen`/`deliveryNote`/`careNote`
i18n keys (item 15 above) — superseded by `page:print-pdp` CMS document
fallback keys (`printPdp.accordion*`) when PR #237 shipped, never cleaned up.

### Cluster 5 (low confidence) — "Phase 0" print-asset manifest code
`print-composition.ts`'s `buildAssetManifest`/`parseCompositionConfig`/
`RENDERER_VERSION`, plus `print-assets-prepare.ts`'s unused
`prepareManifestSchema` union (items 17–18 above). CLI/operator tooling only,
flagged for owner verification rather than as confirmed dead.

---

## Dead API endpoints

**None of the 41 routes under `src/app/api/**` are dead.** Every route has a
traced caller — internal fetch, external webhook/integration, a CLI script,
or (for `/api/feed/*`) an external crawler that pulls on its own schedule.
The one route worth operator attention:

| Route | Method | Callers | External-consumer risk | Status | Recommendation |
|---|---|---|---|---|---|
| `/api/returns` | POST | None (frontend caller removed in PR #295) | N/A | **Intentionally retired** — hardcoded `410 { error: 'return_labels_retired' }` stub with static contact info | Keep the route as-is; delete the dead implementation behind it (Cluster 1) and fix the stale `AGENTS.md`/`docs/cloudflare-deployment.md` descriptions of it |

All Stripe/Prodigi/InPost/Resend/CSP webhooks, the CMS API service-binding
entrypoint, the cron sweep handlers, and both Cloudflare Queue consumers in
`worker.ts` were individually traced and confirmed live — see False
Positives below for the reachability evidence.

---

## Dead backend code

Summarized from the Confirmed/Probably-dead tables above — the backend-only
subset:
- `src/lib/return.ts`, `src/lib/shipx.ts` (return-only exports),
  `src/lib/analytics.ts` (3 builders), `src/lib/checkout-analytics.ts` (2
  wrappers), `src/lib/pricing.ts` (`priceOf`), `src/lib/cms/schemas.ts`
  (`isCmsLocale`), `src/lib/email-layout.ts` (`emailFieldLabel`),
  `src/server/cms-api/shipping-rates-validation.ts` (2 narrowers) — all
  CONFIRMED DEAD.
- `src/lib/catalog/schemas.ts` (`CERAMIC_CATEGORY`), `src/lib/print-assets-prepare.ts`
  (`prepareManifestSchema`), `src/lib/print-composition.ts` (3 exports) —
  PROBABLY DEAD, owner check needed.
- `scripts/lib/compose-master.ts` — CONFIRMED DEAD (scripts/tooling).
- `scripts/test-active-drop-postgres.mjs` — SUSPICIOUS.
- **No dead DB tables, columns, RPCs, or triggers found.** No dead
  Cloudflare bindings (queues, R2, DOs) found — every binding in
  `wrangler.jsonc` has a live reference in `worker.ts` or `src/**`, including
  `WORKER_SELF_REFERENCE` (OpenNext's own cache-purge mechanism — framework
  convention, not orphaned).
- **No dead CI workflow steps.** All 6 `.github/workflows/*.yml` reference
  real scripts/commands/files.
- **No orphaned `package.json` script entries** — all ~44 map to real files
  under `scripts/`.

---

## Dead frontend code

- `src/components/shop/return-status.ts` + test — CONFIRMED DEAD.
- 3 CSS rules tied to the dead return-status UI — CONFIRMED DEAD.
- 7 `returns.*` i18n keys × 4 locales — CONFIRMED DEAD.
- 8 `print.section*` i18n keys × 4 locales — PROBABLY DEAD.
- 4 orphaned CSS selector groups (`.reveal--scale`, `.fade-in`,
  `.showroom-card-price`/`-sold`, `.shop-nav-track.has-filter`) — PROBABLY
  DEAD.
- **No orphaned React components, hooks, or Zustand store actions found** —
  every component/hook/store-action in `src/components/**`, `src/store/**`,
  and the custom-hook set (`useToast`, `useAdminAction`, `useCurrency`,
  `useCart`, `useFilter`, `useCartLines`, `useGooglePlacesLoader`,
  `useMediaQuery`, `useMounted`, `useStripUrlParams`) has a live caller.
- **No leftover component versions from past redesigns** — the 2026-08-28
  home hero rebuild (PR #263), print carousel (PR #265), and 2026-08-29
  footer redesign (PR #267) are all clean; no orphaned prior implementations.
- **No `gb`-locale leftovers** — the 2026-07-05 locale merge into `en` is
  fully clean (no `messages/gb.json`, no `gb` key at any depth, no
  gb-specific route/component).
- **All 9 admin routes** (overview, fulfillment, orders, customers, products,
  pricing, promotions, inventory, content) have real implementations and are
  wired into `AdminNav.tsx` — no orphaned admin pages.

---

## Dead dependencies

**None.** All 32 `package.json` dependencies + devDependencies (Stripe
SDK+Elements, Supabase SSR+JS, Sentry, next-intl, jose, zustand, zod, sharp,
googleapis, schema-dts, wrangler, tsx, vitest, Playwright,
`libphonenumber-js`, etc.) have confirmed live call sites or `npm run`
script invocations. No near-duplicate libraries (single validation lib, single
state lib, single phone lib). `@swc/helpers` looked unused (no direct
import) but is deliberately pinned per `docs/cloudflare-deployment.md` for a
Next/SWC build-time requirement — not a finding.

---

## Legacy / duplicate implementations

| Old implementation | New implementation | Status |
|---|---|---|
| `scripts/lib/compose-master.ts`'s `composeDerivative(path, path, canvas, format, config)` | `scripts/lib/prepare-derivatives.ts`'s `composeDerivative(input: ComposeInput)` | Old one dead (Cluster 3) |
| `src/lib/analytics.ts`'s `Product[]`-based event builders | `*FromItems()` `AnalyticsItem[]`-based builders | Old ones dead (Cluster 2) |
| `src/lib/pricing.ts`'s locale-based `priceOf()` | `priceOfCurrency()` (cookie-driven currency) | Old one dead (item 11) — **and this is what `AGENTS.md`'s Key Conventions section still tells agents to use**, so this drift actively misleads future work |
| `messages/*.json`'s static `print.section*` copy | CMS-driven `page:print-pdp` document + `printPdp.accordion*` fallback keys | Old one probably dead (Cluster 4) |
| `print-composition.ts`'s "Phase 0" manifest builder + `RENDERER_VERSION: '1.0.0'` | `print-assets-prepare.ts`'s `COMPOSE_RENDERER_VERSION: '3.0.0'` (the version actually checked at runtime) | Old one probably dead (Cluster 5) |

---

## False positives / verified live code

Listed because they demonstrate dynamic/external/framework-based usage was
actually traced, not assumed:

- **`worker.ts`** — read in full. The `fetch` handler, the `queue` handler
  (asset-jobs pipeline + generic DLQ branch), the `scheduled` handler's 6
  `ctx.waitUntil` sweeps, and all re-exports (`DOQueueHandler`,
  `DOShardedTagCache`, `BucketCachePurge`, `CmsApi`, `PrintAssetProcessor`)
  are all wired and live.
- **`CmsApi` service-binding entrypoint** (`src/server/cms-api/**`) — has no
  HTTP route or in-repo caller by design (reachable only via Cloudflare
  Service Binding from the separate `cms-ceramics` app). Confirmed its
  router registers 41 real handlers, none falling through to the generic
  404 — **and confirmed the S2–S4 operations (content, pricing,
  shipping-rates, collections, uploads, jobs) are fully implemented**, not
  `404 NOT_IMPLEMENTED` as `AGENTS.md`/`docs/cms-api-s1-handoff.md` still
  claim (see Documentation drift).
- **Gift-card balance ledger** (`src/server/balance-refunds.ts`,
  `gift-card-checkout.ts`, `issue-balance-gift-card.ts`,
  `recover-balance-orders.ts`, `/api/admin/balance-refund`) — absent from
  `AGENTS.md` entirely, but confirmed merged (PR #296), live in `worker.ts`'s
  scheduled handler and `webhook.ts`. Undocumented, not dead.
- **Print-asset Container pipeline** (`src/server/asset-jobs/**`, the
  `PrintAssetProcessor` Durable Object) — confirmed wired end-to-end via
  `wrangler.jsonc` (`containers[]`, DO binding, `ASSET_JOBS_QUEUE`+DLQ+
  preview queue names) matching `worker.ts`'s queue-consumer branch. Newer
  than what `AGENTS.md` documents, not dead.
- **`HANDLED_STRIPE_EVENTS` vs. the `handleStripeEvent` switch** — exact 1:1
  correspondence, no dead branches.
- **`src/lib/admin/actions.ts`'s 4 exports** — all confirmed called from
  both their `/api/admin/*` route *and* `scripts/orders-cli.ts` (a
  multi-line import block initially missed by a naive single-line grep).
- **`resend-events.ts`** (abandoned-cart Resend automation) — the code path
  (`sendCheckoutStartedEvent`/`sendPurchasedEvent` → build → send) is live
  and called from `checkout/route.ts` and `stripe/webhook/route.ts`; only
  the Resend-side dashboard automation is administratively paused, not the
  code.
- **`src/lib/return-rate-limit.ts`** — looks retirement-adjacent by name
  (see Cluster 1) but survived as the engine behind
  `createAuthRateLimiter()` for `/api/auth/login`.
- **`read-category-products.ts`** — looked unused by static-import grep, but
  is spawned as a subprocess (`execFileSync`) by
  `scripts/generate-product-notes.mjs`.
- **`quiet-static-assets-incremental-cache.ts`** — unreferenced by an
  `src/`-scoped grep, but wired in via the root-level `open-next.config.ts`.
- **USD/CAD currency scaffolding** (`PRICE_USD`, `PRICE_CAD`, `toUSDCents`,
  etc.) — present and unused by any live currency path, but this is
  `AGENTS.md`'s explicitly-documented intentional scaffolding. Not flagged.
- **9 DB RPCs with no direct app-code caller** (`assert_print_assets_ready`,
  `guard_print_asset_immutable`, `guard_print_product_activation`,
  `prevent_legacy_gift_card_spending`, `pricing_config_draft_values`,
  `print_asset_readiness_missing`, `shipping_rate_draft_values`,
  `shipping_rate_field_keys`, `ceramic_drop_conflicts`) — all verified
  called from sibling migration SQL (trigger bodies / `perform` calls),
  which is correct internal factoring.
- **`checkout_payment_modes` table** — 0 direct `.from()` references, but
  accessed exclusively inside `claim_checkout_payment_mode()`, which IS
  called from `checkout/route.ts:325`.
- **`WORKER_SELF_REFERENCE` binding** — 0 direct `src/` references; it's
  OpenNext's own cache-interception self-fetch mechanism
  (`enableCacheInterception: true`), matching `AGENTS.md`'s description.
- **`contracts/fixtures/*.json`** (16 files) — 0 in-repo references, but
  confirmed as a deliberate cross-repo handoff artifact for `cms-ceramics`
  per `AGENTS.md`/`docs/cms-api-s1-handoff.md`.
- **`src/app/[locale]/(collections)/fine-art-prints/page.tsx`** — looks
  unreachable (permanently redirected to `/sklep` by `next.config.ts`), but
  is already a deliberate, self-commented 4-line re-export shim, not bloat.
- **Ad-hoc ops scripts** (`export-orders-csv.ts`, `export-inpost-bulk-csv.ts`,
  `translate-product-notes.mjs`, `verify-analytics-count.mjs`) — carry
  explicit "run directly with tsx, not a package.json script" header
  comments and doc references; an established repo convention, not orphaned.
- **`.tile--lead`/`.tile--wide` CSS** — built dynamically as
  `` `tile--${feature}` `` in `ProductTile.tsx`; confirmed live via
  `src/lib/bento.ts` + asserted by `e2e/collection-bento.spec.ts`.
- **Dynamic i18n keys** (`` t(`print.size.${size}`) ``,
  `` t(`print.colour_${colour}`) ``, `home.heroLine1` via CMS-fallback
  object-member access, `printPdp.accordion*`, `collection.${slug}.*`,
  `product.${category}`, `cart.see${Category}`,
  `account.status.${status}`) — all missed by a literal-string automated
  sweep, individually spot-checked and confirmed live.
- **All 6 GitHub Actions workflows and all `package.json` script entries** —
  every referenced file/command exists.

---

## Documentation drift found during the audit

Not code-removal findings, but they materially affect trust in this repo's
own architecture doc and directly caused (and were caught by) false-positive
checks during this audit, so they're recorded here for whoever owns `AGENTS.md`:

1. **`AGENTS.md`'s CMS API section** claims S2–S4-scoped operations
   (content/pricing/shipping-rates/assets/uploads/jobs) return
   `404 NOT_IMPLEMENTED`. They're fully shipped (2026-09-15 → 09-17,
   commits `64bfa7b6`…`a0a73351`). Same claim in `docs/cms-api-s1-handoff.md`
   (currently indexed "active").
2. **`AGENTS.md`'s Deployment section** (`wrangler.jsonc` bindings) omits
   `ASSET_JOBS_QUEUE`+DLQ, the `containers`/`PrintAssetProcessor` DO block,
   and the entire `env.preview` block.
3. **`AGENTS.md`** has no architecture section for the **gift-card system**
   at all (tables, 6 RPCs, `checkout_payment_modes`, `/api/admin/balance-refund`,
   the balance-order recovery sweep) despite it being live since PR #296.
4. **`AGENTS.md`** has no mention of the **print-asset Container pipeline**
   (`src/server/asset-jobs/**`, `PrintAssetProcessor` DO).
5. **`AGENTS.md`** still describes `/api/returns` as creating a return
   shipment; it's a `410` stub (Cluster 1). Same stale claim in
   `docs/cloudflare-deployment.md`.
6. **`AGENTS.md`'s Key Conventions** tells agents to use `priceOf(product,
   locale)`; the live convention is `priceOfCurrency()` (item 11).
7. **`AGENTS.md`** describes `/sklep` as rendering "every piece grouped by
   category in a single `GroupedGallery` with a sticky category jump-nav."
   `GroupedGallery`/`AllPiecesScreen` don't exist in the current codebase —
   `/sklep` renders `PrintCollectionScreen` (fine-art prints only) today.
8. **`AGENTS.md`** describes `/fine-art-prints` as "its own route"; it's now
   a permanent redirect shim to `/sklep` (PR #295).
9. **`docs/README.md`**'s doc index has no entry for
   `docs/gift-card-balance-runbook.md`, which exists and is referenced from
   code context.
10. **`docs/STATUS.md`**'s "Fine-art prints" row (last verified 2026-08-28)
    predates collections/curation work that continued past that date (PR #329,
    merged, visible at current HEAD).
11. **Lifecycle-rule violation, ~20–25 files:** `docs/plans/ceramics-prints-separation/**`
    (9 files, self-marked all-DONE 2026-07-07), `docs/superpowers/plans/2026-08-12-remediation-{01,02,03,05,06,07,08,11}-*.md`
    (8 files, master index marks them ✅ MERGED), `docs/superpowers/plans/2026-08-30-promo-codes-{master,phase-1…7}.md`
    (8 files, STATUS.md confirms shipped 2026-08-31) — all sitting outside
    `docs/archive/` despite this repo's own stated "move to archive when
    done" rule. Lower-confidence additional candidates:
    `2026-08-10-print-pdp-sections.md`, `print-checkout-address-management.md`,
    `private-sale-cart-link.md`, `2026-07-13-prodigi-contract-smoke.md` (+spec),
    `2026-06-10-editorial-section.md`, four `2026-07-07-storefront-*.md`
    files.
12. **`docs/plans/2026-storefront-upgrade.md`** + 2 child specs — mixed/stale
    status (see Suspicious items 25–26).

---

## Recommended cleanup order

Organized by technical dependency/risk, not by feature importance.

1. **Confirmed dead code with no dependents — zero risk, do first.** Items
   1–14 (Cluster 1's returns-flow files/CSS/i18n/env-vars, Cluster 2's
   legacy analytics builders, Cluster 3's `compose-master.ts`, and the
   standalone `priceOf`/`isCmsLocale`/`emailFieldLabel`/shipping-rates
   narrowers). None of these are on the payment, webhook, or fulfilment
   critical path. Delete files + their tests + their i18n keys + their env
   vars together per cluster; run `npm run lint && npm run typecheck &&
   npm run test` after.
2. **Documentation fixes alongside step 1.** Update `AGENTS.md`'s `/api/returns`
   description and Key Conventions' `priceOf` mention, and
   `docs/cloudflare-deployment.md`'s `STUDIO_RETURN_*` claim, in the same PR
   that removes Cluster 1 — otherwise the docs go stale the moment the code
   lands correctly.
3. **Dead dependencies.** None found — skip.
4. **Probably-dead items needing a small owner check (items 15–22).** Each
   is a single Slack/PR-comment-sized question: confirm `cms-ceramics`
   doesn't reference the old `print.section*` keys, confirm the Stage 4c
   catalog-editor owner doesn't need `CERAMIC_CATEGORY`, confirm the
   print-asset-pipeline owner is done with the "Phase 0" manifest code, and
   sanity-check the 4 CSS selector groups against any near-term design
   plans. Low risk either way — worst case is a re-added CSS rule.
5. **Suspicious items (23–26), all doc-only or dev-tooling, zero prod risk.**
   Document or delete `test-active-drop-postgres.mjs`; resolve the staging-plan
   ambiguity with the operator; update `2026-storefront-upgrade.md`'s status
   table for Specs C and D.
6. **Documentation-currency pass (no code changes, high value).** Fix the 12
   items in [§ Documentation drift](#documentation-drift-found-during-the-audit) —
   especially items 1–4 and 6–8, since a future audit or agent session that
   trusts `AGENTS.md` literally will misidentify what's live (this audit
   caught itself on several of these mid-investigation). Batch-archive the
   ~20–25 shipped plan/spec files into `docs/archive/` per this repo's own
   lifecycle rule, and update `docs/README.md`'s index accordingly.

No item in this report sits on the payment, webhook, fulfilment-queue, or
cron-sweep critical path — the returns-flow cluster is the largest single
piece of removable code, and it stopped receiving traffic 2+ weeks before
this audit ran.
