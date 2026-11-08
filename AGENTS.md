# AGENTS.md

Guidance for AI coding agents working in this repository. This is the **canonical** project context file. Consumers: **Claude Code** (primary — reads it via the `@AGENTS.md` import in `CLAUDE.md`), **Codex** (code review — reads it natively), **Cursor** (MCP work + GitHub chores — plus the scoped rules in `.cursor/rules/`). Keep this file to *stable* architecture, commands, and conventions; perishable feature-state facts belong in `docs/STATUS.md`.

## Project Overview

An e-commerce storefront for one-of-a-kind ceramic pieces by Anna Ciok. Built with Next.js 16 App Router, deployed on Cloudflare Workers via OpenNext. Ceramics are unique (no quantities) — once sold, they're gone. The catalogue is **~125 live ceramic pieces across 9 categories** (`src/lib/products.test.ts` asserts the exact count). The store also sells **fine-art prints fulfilled on demand via Prodigi** — a separate registry (`src/lib/prints.ts`) and a separate order/fulfilment path (see Fine-Art Prints & Prodigi below). **Four locales** (Polish default at unprefixed `/`, plus `/en` `/es` `/de`) and **multi-currency driven by a `currency_pref` cookie** (not the locale): `pl` always prices in PLN; every other locale defaults to EUR and can switch to GBP (auto-seeded from the visitor's `CF-IPCountry`, overridable in the header switcher). USD/CAD are scaffolded in the type/DB/format layer but throw in `priceOfCurrency` and are hidden until their price tables land. Live at [anna-ciok.studio](https://anna-ciok.studio).

## Commands

```bash
npm run dev           # Local dev server (next dev --webpack)
npm run build         # Production build (next build --webpack — see Build system)
npm run lint          # ESLint
npm run typecheck     # tsc --noEmit (app + worker via tsconfig.worker.json)
npm run test          # Vitest unit tests (src/**/*.test.ts; --passWithNoTests)
npm run test:e2e      # Playwright E2E (@ci specs) — hermetic localhost by default (webServer build+serve)
npm run test:e2e:edge # Playwright E2E (@checkout-edge specs) — real Geowidget + Stripe; set PLAYWRIGHT_BASE_URL for prod
npm run preview:cf    # OpenNext + Wrangler local preview on :8787 (Workers runtime)
npm run deploy:cf     # Build & deploy to Cloudflare Workers
npm run optimize-images  # Convert design/uploads/*.png → public/uploads/*.webp
```

Run a single unit test file:

```bash
npx vitest run src/lib/products.test.ts
```

Run a single E2E spec:

```bash
npx playwright test e2e/purchase-two-categories-paczkomat.spec.ts
```

### Operational / one-off scripts

~30 operational scripts (orders, prodigi, `print-assets:*`, `collections:*`, `reconcile:orders`, `i18n:*`, `gtm:*`, `gmc:fetch`, …) — full table with purposes and runbook links: [docs/agent-context/scripts-reference.md](docs/agent-context/scripts-reference.md). Read it, and the linked runbook, before running anything mutating.

- `npm run orders -- …` — order/inventory inspection + the four admin mutations (refund, release-reservation, resend-confirmation, create-shipment). Mutations need `--confirm <order-id>`; non-prod is blocked without `--allow-nonprod`; PII redacted by default. Prefer it over raw SQL. → `docs/orders-cli.md`
- `npm run prodigi -- …` — Prodigi API CLI, sandbox unless `--live`; paid production orders always go through the queue. → `docs/prodigi-cli.md`

## Tooling

Agents with the **Serena** MCP server configured (semantic, LSP-backed code navigation and structure-aware editing — symbol search, find-references, rename, structural edits) should prefer it over plain grep/read for non-trivial exploration, cross-file impact analysis, or refactors in this repo: it resolves TypeScript symbols and references directly instead of guessing from text search. It's optional — not every agent/session has it wired up, so fall back to standard file/grep tools when it isn't available. Serena's own project config lives outside the repo tree (not under a tracked `.serena/`), so there's nothing to install or maintain here.

## Context map (where knowledge lives, and what to trust)

- **This file** — stable architecture, commands, conventions. **`docs/STATUS.md`** — perishable feature-state facts with last-verified dates; check it before relying on anything time-sensitive.
- **`docs/agent-context/`** — full detail for each Architecture subsection below (scripts, registry, storefront, webhooks, prints, admin/CMS, API routes, schema, pricing, analytics, env vars). The stubs in this file carry only the invariants; **read the matching file before changing that area.**
- **`docs/README.md`** — index of all docs with status tags (`active` / `runbook` / `reference` / `superseded` / `historical`). Start there when hunting for guidance.
- **Plans & specs** — dated `YYYY-MM-DD-*` files in `docs/plans/` and `docs/superpowers/{plans,specs,summaries}/`. **Lifecycle rule:** when a plan/spec is done or superseded, move it to `docs/archive/` and update the index; audits go in `docs/audits/` only. Never treat an archived or older-dated file as current without verifying against the code.
- **Cleanup guidance trust chain:** `docs/cleaning-instructions.md` is authoritative; `docs/pony-audit.md` is reference (note its CATALOG_SOURCE retraction); `docs/archive/CODE_CLEANING_PLAN.md` is superseded.
- **`docs/archive/`** — historical material kept for rationale only; every file carries a banner saying what superseded it. Facts inside may be false today.
- **Build-guard enforcement:** the webpack-only rule below is enforced by `scripts/build-config.test.ts` (runs in `npm test` + CI for every agent) and, in interactive Claude Code sessions, by a PreToolUse hook in `.claude/settings.json`. Do not weaken either.
- **Claude Code note:** shared project settings live in the tracked `.claude/settings.json`; personal/machine-specific config (Serena hooks, wider permissions) belongs in the gitignored `.claude/settings.local.json`.

## Architecture

### Product Registry

Detail: [docs/agent-context/product-registry.md](docs/agent-context/product-registry.md). Invariants:

- Ceramics are statically defined in `src/lib/products.ts`; the public accessors are **async** and read a DB-driven catalog when `CATALOG_SOURCE=db` (**production**, `wrangler.jsonc`); `code` (unset default) is the local/test fallback. `piece_state` is the source of truth for sold/reserved.
- Do **not** wrap DB catalog/pricing reads in `unstable_cache` or couple them to cache invalidation (no persistent tag cache is deployed); catalog-consuming routes must stay out of prerender manifests (`force-dynamic` where noted).
- `npm run catalog:backfill` is a structural sync, not a print publication; print activation is guarded in the DB (`update_product_status_guarded()`, readiness predicate).
- Visibility: `isProductPublic` (status + hidden families) vs `isProductPurchasable` (also excludes sold/showroom). Product ids are stable tokens (`k01`); price is an integer in PLN, other currencies derived per category.
- CMS content layer (`cms_documents`, atomic `publish_cms_version()` RPC): `page:print-pdp` and `page:home` fall back to committed copy when unpublished.

### Storefront Surfaces

Detail: [docs/agent-context/storefront-surfaces.md](docs/agent-context/storefront-surfaces.md). Invariants:

- Routes live under `src/app/[locale]/`; groups `(collections)` (has `loading.tsx`) and `(pdp)` (**no** `loading.tsx`, so `notFound()` returns a real 404). `/kolekcje` lives directly under `[locale]/` for the same reason.
- Surfaces: homepage (CMS hero + daily print rail), ceramic collections `/{category}`, `/sklep` print shop, `/kolekcje`, `/showroom`, PDPs `/{category}/{id}` and `/fine-art-prints/{id}`, `/konto` (customer accounts, fail-closed behind `SUPABASE_PUBLISHABLE_KEY`). `/fine-art-prints` 308-redirects to `/sklep`.
- Product photos render at natural ratio, never cropped; native `<img>` via `srcSet()`, not `next/image`.

### Cart

Zustand store in `src/store/cart.ts`, persisted to `localStorage` under key `acc_cart_v1`. The cart is just a Set of tokens — no quantities, no server sync. Ceramic pieces are stored by bare product id; **fine-art prints are stored as `print:<design>:<size>:<framed>:<mount>:<frameColour>` tokens**. Both kinds live in the same cart and are resolved for the UI via `src/lib/cart-lines.ts`. Ceramic cart state is reconciled against live inventory on the checkout page via `/api/inventory`. **A mixed cart (ceramics + prints) cannot be checked out together** — they follow separate fulfilment paths and produce separate orders.

### Checkout Flow (Critical Path)

1. **Client:** User fills delivery details, clicks pay → POST `/api/checkout`
2. **Server (`src/app/api/checkout/route.ts`):**
   - Derives **currency from the `currency_pref` cookie** (via `getCurrency` in `src/lib/currency.server.ts`): `pl → PLN`; other locales use the cookie clamped to a switchable currency (EUR default, GBP), falling back to EUR
   - Validates cart items (`validateCart` in `src/lib/checkout.ts`, currency-aware) and delivery details — ceramic carts via `validateDelivery` (`src/lib/shipx.ts`), print carts via `validatePrintDelivery` (`src/lib/print-delivery.ts`: native `line1`/`line2` address, country from `PRINT_COUNTRIES`, phone normalised to E.164 with `libphonenumber-js/max`)
   - Calls Supabase RPC `reserve_pieces()` — atomic lock with 15-min TTL; returns conflicting IDs on conflict. An optional **private-sale token** (`src/lib/private-sale.ts`) instead reserves already-sold pieces via `reserve_private_sale_pieces()`
   - Creates Stripe `PaymentIntent` (amount in minor units — grosze for PLN, euro-cents for EUR, pence for GBP) with `payment_method_configuration` from the `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` runtime secret (mode-specific; checkout fails closed with `502 stripe_failed` if unset) — this enables **BLIK / Przelewy24 / Bizum / cards** without per-Dashboard wiring
   - Captures marketing context (cookies, IP, UA, consent) into `orders.marketing` for server-side conversions
   - Persists `orders` + `order_items` rows
   - Returns `client_secret` to client (or `502` with `{ error: 'stripe_failed' }` if PI creation fails)
3. **Client:** Stripe PaymentElement completes payment
4. **Return page (`/koszyk/return`):** Calls `stripe.retrievePaymentIntent()` once on mount via `payment_intent_client_secret` query param; maps status to success/processing/failure — no polling loop

### Webhook Fulfillment

Detail (full event table, cron sweeps, queue/DLQ consumers): [docs/agent-context/webhook-fulfilment.md](docs/agent-context/webhook-fulfilment.md). Invariants:

- `handleStripeEvent()` in `src/lib/webhook.ts` serves `/api/stripe/webhook`; every delivery is wrapped in the shared `webhook_events` idempotency ledger. A competing delivery answers **409** on purpose (Stripe redelivers) — do not tune the 409s away.
- Event set is `HANDLED_STRIPE_EVENTS`; live subscriptions are drift-gated by `npm run orders -- webhook-config-check`. Ceramic orders → `createShipment` (InPost); print orders → `enqueueProdigi()` (Cloudflare Queue).
- **API-version ritual** on every `stripe` package bump: update `STRIPE_API_VERSION` in `src/lib/stripe.ts`, update the snapshot webhook endpoint's API version in the Stripe Dashboard in lockstep, then verify with `npm run orders -- webhook-config-check`.
- `worker.ts` also runs a 15-min cron (five sweeps, each self-alerting to Sentry), the `prodigi-fulfilment` queue consumer, and an alert-only DLQ consumer.

### Fine-Art Prints & Prodigi (print-on-demand)

Detail: [docs/agent-context/prints-prodigi.md](docs/agent-context/prints-prodigi.md). Invariants:

- Prints are POD variants (size × frame), **not** one-of-a-kind, in a separate registry `src/lib/prints.ts`; the store never holds print stock. Mixed carts (ceramics + prints) cannot be checked out together.
- Prodigi integration lives in `src/server/` (`prodigi/` client+mapper+callbacks, `fulfilment/` queue pipeline); high-res files are served via HMAC-signed R2 URLs at `/api/print-assets/[id]`.
- Use `npm run prodigi -- …` for Prodigi debugging; SKU reference `docs/prodigi-sku-catalog.md`; reconcile SKUs with `npm run sync-prodigi-skus`.

### Admin (Studio dashboard)

Detail (admin + CMS API entrypoint): [docs/agent-context/admin-cms-api.md](docs/agent-context/admin-cms-api.md). Invariants:

- Back-office at `src/app/admin/` (outside `[locale]`), helpers in `src/lib/admin/`; every `/admin` and `/api/admin` request is gated in production by a **Cloudflare Access JWT** verified in `worker.ts`. `/api/admin/*` routes are thin adapters over `src/lib/admin/actions.ts`.
- `CmsApi` (`WorkerEntrypoint`, `src/server/cms-api/`) is reachable **only** via a Cloudflare Service Binding, with its own Access audience/team trust boundary; contract is `contracts/cms-v1.json`. Unimplemented operations return `404 NOT_IMPLEMENTED` by design.

### Other API Routes

Full route list with behaviours: [docs/agent-context/api-routes.md](docs/agent-context/api-routes.md). Invariants:

- Merchant feeds (`/api/feed/google`, `/api/feed/meta`) are **fine-art prints only**; ceramics are deliberately excluded (one-of-a-kind ⇒ unavoidable availability mismatch). `en` is fixed to GBP/GB in feeds and print-PDP JSON-LD.
- Private-sale links are ceramics-only (`400 private_sale_prints_unsupported` with prints). `/api/returns` is retired (static 410). `/api/auth/*` is fail-closed 404 unless `SUPABASE_PUBLISHABLE_KEY` is set. `/api/debug/fulfilment-status` is secret-gated and never enabled in production.

### Internationalization

Four locales: Polish (default, no prefix), English (`/en`), Spanish (`/es`), German (`/de`). Configured in `src/i18n/routing.ts` (`localePrefix: 'as-needed'`). There is **no separate `gb` locale** — it was merged into `en` (spec `docs/superpowers/specs/2026-07-05-en-gb-locale-merge-design.md`); GBP is a cookie-driven display currency, not a locale. Display currency is decoupled from locale — it comes from the `currency_pref` cookie (see Pricing & Shipping), not the locale. The one fixed exception is the merchant feed (`/api/feed/*?locale=en`) and the print PDP JSON-LD it must agree with: both quote `en` in GBP/GB unconditionally, because a feed and its statically-rendered landing-page schema have no visitor session to read a cookie from (see § Other API Routes). All UI strings — including per-product `notes` — live in `messages/{pl,en,es,de}.json`. Server components use `getTranslations()`, client components use `useTranslations()`. Always import `Link` and `useRouter` from `src/i18n/navigation.ts` (not Next.js directly) to preserve locale.

### Database Schema (Supabase)

Table-by-table schema notes: [docs/agent-context/database-schema.md](docs/agent-context/database-schema.md). Invariants:

- Core tables: `piece_state`, `drops`, `orders`, `order_items`, `private_sales`, `fulfilment_jobs`, `prodigi_orders`, `pod_variants`, `webhook_events`, `promo_codes`/`promo_redemptions`, `product_interest`. Migrations go in `supabase/migrations/` (timestamp prefix) and auto-apply on merge to `main`.
- RLS is enabled; all server code uses the service-role client `getSupabaseAdmin()`. `reserve_pieces()` is the atomic reservation RPC (returns conflicting ids; empty = success).

### Pricing & Shipping

Detail: [docs/agent-context/pricing-shipping.md](docs/agent-context/pricing-shipping.md). Invariants:

- Display currency comes from the `currency_pref` cookie, not the locale (`pl → PLN`; others EUR, switchable to GBP). Minor units are integers: grosze / euro-cents / pence (`toGrosze()` etc.), checkout/Stripe only.
- Print prices come from the global admin-editable price list (`print_pricing_config`, EUR-canonical); keep `DEFAULT_PRINT_PRICING` in lockstep. Prints ship to a home address, never a locker.
- Shipping rates are CMS-published: every surface that displays a shipping price must read `getShippingRatesForDisplay()`, never the `SHIPPING_*` constants (outage fallback only). After publishing rates run `npm run gmc:fetch -- --confirm`.

### Analytics & Conversions

Detail: [docs/agent-context/analytics-conversions.md](docs/agent-context/analytics-conversions.md); event contract in `docs/analytics-stack.md`. Invariants:

- Client: GTM + GA4 + Meta Pixel behind Consent Mode v2. Server: Purchase to Meta CAPI + GA4 MP from the webhook (`src/lib/marketing/`), consent-gated, claimed once per order via `orders.conversions_sent_at`.
- Browser and server share the deterministic event id `purchase-<payment_intent_id>`. Passing a distinct client `orderNo` without updating `conversions.ts` breaks dedup.

### Environment Variables

Complete variable list: [docs/agent-context/environment-variables.md](docs/agent-context/environment-variables.md) and `.env.example`. Rules:

- `NEXT_PUBLIC_*` are **build-time** (Workers Build env vars), not wrangler secrets. Runtime secrets use `wrangler secret put` in prod and `.dev.vars` locally. Secrets never reach the client.
- Several features are fail-closed when their secret is unset (`SUPABASE_PUBLISHABLE_KEY`, `NEWSLETTER_CONFIRM_SECRET`, `CMS_PREVIEW_SECRET`, `FULFILMENT_DEBUG_TOKEN`, `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`). Never reuse one secret for another purpose.
- New env reads must be added to `.env.example` (`scripts/env-example-completeness.test.ts` enforces it).

## Key Conventions

**Monetary values:** PLN in grosze, EUR in euro-cents, GBP in pence — always integers. Use `pln()` from `src/lib/format.ts` for PLN display, and `priceOfCurrency(product, currency)` (currency-cookie-driven, see § Pricing & Shipping) to pick the right value for the visitor's display currency. Grosze/euro-cents are a checkout/Stripe-only rule; the analytics layer uses major units.

**Server vs client components:** Default to server components (async). Add `'use client'` only when needed for state, hooks, or browser APIs. Secrets (Stripe, Supabase admin, conversion tokens) are never exposed to the client — all sensitive operations go through API routes or the webhook.

**Product IDs:** Single-letter category prefix + zero-padded number (`k01` = kubki 01). The `id` is a STABLE token — it never renumbers when the catalogue is cut; the display `num` and `category` may change via the inventory-review diff in `products.ts`. Ceramic category slugs (9): `kubki`, `wazony`, `wazony-srednie`, `wazony-duze`, `talerzyki`, `talerze-srednie`, `talerze-duze`, `duze-michy`, `miski-falowane`. A 10th `CategorySlug`, `fine-art-prints`, is the POD prints surface — it is intentionally excluded from `CATEGORY_ORDER` so ceramic code paths ignore it.

**Code layers:** `src/lib/` holds domain/business logic (products, pricing, checkout, marketing). `src/server/` holds third-party fulfilment integration (Prodigi client + the Cloudflare Queue pipeline). `src/app/admin/` and `src/lib/admin/` are the back-office, gated by Cloudflare Access in production.

**CSS:** Token-driven via custom properties in `src/styles/tokens.css` (`--c-*` colors, `--f-*` fonts, `--gut` gutter, `--section-y` spacing, `--r-*` radii). No CSS-in-JS — plain CSS files colocated with components or in `src/styles/`.

**Responsive images:** Use `srcSet()` from `src/lib/images.ts` for product images (native `<img>`, not `next/image` — see SEO note). All product images are WebP in `public/uploads/`, generated from gitignored `design/uploads/` via `npm run optimize-images`.

**API error responses:** `NextResponse.json({ error: reason }, { status: code })`. Checkout returns 400 (validation — print carts fail delivery validation with `{ error: 'invalid_delivery' | 'invalid_contact' | 'invalid_address' }` from `validatePrintDelivery`), including `{ error: 'private_sale_prints_unsupported' }` when a private-sale token is sent with a print cart, `{ error: 'invalid_promo', reason }` for an ineligible promo code (`reason` one of `not_found|inactive|not_started|expired|wrong_track`), 409 with `{ error: 'unavailable', sold: string[] }` (pieces unavailable), 409 `{ error: 'order_conflict' }` (stale attemptId — client must reset it), 409 `{ error: 'checkout_in_progress' }` (a concurrent or unresolvable POST for the same attemptId — client must KEEP the attemptId and retry), 409 `{ error: 'print_asset_unavailable' }` (no ready/usable print asset for the requested variant — runs before reservation/PI), 409 `{ error: 'promo_exhausted' }` (promo capacity gone, including a race lost after PI creation — full rollback), 502 with `{ error: 'stripe_failed' }` (Stripe PI creation failure), 503 `{ error: 'print_asset_error' }` (transient Supabase failure resolving the print asset — safe to retry, before any reservation/PI), 500 (other server faults, including `{ error: 'promo_claim_failed' }` when the redemption-claim RPC itself errors).

**Analytics:** Fire `begin_checkout` when the user clicks pay in `CartView` (before POST `/api/checkout`). Fire deduplicated `purchase` and `payment_failed` events on the return page (keyed by `payment_intent` ID via sessionStorage to prevent double-counting on refresh).

**Build system:** Always use webpack — never Turbopack. The `build` script in `package.json` must stay as `next build --webpack`. OpenNext cannot load Turbopack chunks at the Cloudflare Workers runtime (causes ChunkLoadError → HTTP 500 on every page). Do not remove `--webpack`, do not add `--turbo`, do not suggest switching to Turbopack for any reason.

## Versioning

The canonical version lives in `package.json` `version` — single source of truth; the admin badge, Sentry `release`, git tags, and `CHANGELOG.md` all derive from it. `next.config.ts` inlines it at build as `NEXT_PUBLIC_APP_VERSION` (shown in the admin header as `vX.Y.Z · <short-sha>`) and as the Sentry release (`src/lib/sentry-options.ts`).

Bumps are automated by **release-please** (`.github/workflows/release-please.yml`) from Conventional Commits: it maintains a "release PR" that bumps `package.json` + writes `CHANGELOG.md`; merging it creates the `vX.Y.Z` tag + GitHub Release. Prod still deploys via Cloudflare Workers Builds on every push to `main` — the version tag lands when the release PR merges.

**Commit → version mapping:** `feat:` → minor (`0.8.0`), `fix:`/`perf:` → patch (`0.7.x`), `feat!:` / `BREAKING CHANGE:` → major (`1.0.0`). `chore:`/`docs:`/`test:`/`refactor:`/`ci:` commits do **not** cut a standalone release — they fold into the next `feat:`/`fix:` release. So for a routine PR that should ship a version bump, title it `fix:` (or `feat:`) rather than `chore:`. Current series is pre-1.0 (`0.x`).

## Deployment

Cloudflare Workers via OpenNext (`open-next.config.ts`). Preview locally with `npm run preview:cf`. Workers Builds CI handles production deploys on push to main. The configured incremental-cache adapter reads prerendered/static assets and deliberately does not persist writes; the OpenNext tag-cache adapter is `dummy`. Generated cache Durable Object exports are still required by the OpenNext worker bundle, but they do not make application data-tag invalidation available. Catalog and print-pricing DB reads therefore bypass Next's persistent data cache, and catalog-consuming routes must remain absent from generated prerender manifests. Next `postbuild` and the post-OpenNext copy guard both fail closed when required artifacts are missing; preview, deploy, and Wrangler's custom build all use the guarded OpenNext build.

Key `wrangler.jsonc` bindings: `ASSETS` (static assets from `.open-next/assets`), `WORKER_SELF_REFERENCE` service binding (self-reference for cache purging), `FULFILMENT_QUEUE` (Cloudflare Queue `prodigi-fulfilment`, consumer with exponential retry/backoff plus a dead-letter queue `prodigi-fulfilment-dlq` consumed alert-only), `PRINT_ASSETS` (R2 bucket for high-res print files), and a cron trigger every 15 min.

`worker.ts` wraps the OpenNext handler and adds the cron scheduled handler, the Prodigi **queue consumer**, and the Cloudflare Access gate for `/admin`. Every fetch runs inside a per-request degradation scope (`src/lib/request-degradation.ts` + `request-degradation-scope.ts`): when a render was served from the cold-fail-closed ceramic catalogue, a 404 or `/sitemap.xml` is answered **503 + `Retry-After`** instead, so crawlers do not drop live pieces during a transient Supabase outage. It **must** re-export `DOQueueHandler`, `DOShardedTagCache`, and `BucketCachePurge` from `.open-next/worker.js` — omitting these breaks deployment.

`src/middleware.ts` must **not** be renamed to `proxy.ts`: OpenNext only bundles edge-runtime middleware, but Next 16's `proxy.ts` is Node-runtime only and OpenNext rejects it, breaking the Cloudflare build (`next build` alone does not catch this — the failure only surfaces in the OpenNext/Workers build). A rename was attempted once and cancelled for exactly this reason.

New migrations go in `supabase/migrations/` with timestamp prefix. Docs for deployment, E2E testing design, and analytics setup are in `docs/`.
