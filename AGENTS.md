# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, Copilot, …) working in this repository. This is the **canonical** project context file; Claude Code reads it via an `@AGENTS.md` import in `CLAUDE.md`.

## Project Overview

An e-commerce storefront for one-of-a-kind ceramic pieces by Anna Ciok. Built with Next.js 16 App Router, deployed on Cloudflare Workers via OpenNext. Ceramics are unique (no quantities) — once sold, they're gone. The catalogue is **~125 live ceramic pieces across 9 categories** (`src/lib/products.test.ts` asserts the exact count). The store also sells **fine-art prints fulfilled on demand via Prodigi** — a separate registry (`src/lib/prints.ts`) and a separate order/fulfilment path (see Fine-Art Prints & Prodigi below). **Four locales** (Polish default at unprefixed `/`, plus `/en` `/es` `/de`) and **multi-currency driven by a `currency_pref` cookie** (not the locale): `pl` always prices in PLN; every other locale defaults to EUR and can switch to GBP (auto-seeded from the visitor's `CF-IPCountry`, overridable in the header switcher). USD/CAD are scaffolded in the type/DB/format layer but throw in `priceOfCurrency` and are hidden until their price tables land. Live at [anna-ciok.studio](https://anna-ciok.studio).

## Commands

```bash
npm run dev           # Local dev server (next dev --webpack)
npm run build         # Production build (next build --webpack — see Build system)
npm run lint          # ESLint
npm run test          # Vitest unit tests (src/**/*.test.ts; --passWithNoTests)
npm run test:e2e      # Playwright E2E (@ci specs) — runs against deployed site by default
npm run test:e2e:edge # Playwright E2E (@checkout-edge specs) — real Geowidget + Stripe
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

Operational / one-off scripts (full list in `package.json`): `npm run prodigi` (Prodigi API v4 CLI — sandbox quotes/orders, SKU lookup, order inspection; see `docs/prodigi-cli.md`), `npm run orders` (order/inventory inspection CLI + the four admin mutations — refund, release-reservation, resend-confirmation, create-shipment; see `docs/orders-cli.md`), `npm run private-sale:create` (mint a re-sale link for sold pieces), `npm run sync-prodigi-skus` (verify/upsert Prodigi print SKUs into `pod_variants`), `npm run print-assets:prepare` / `print-assets:upload` / `print-assets:verify` / `print-assets:publish` (the print-fulfilment asset pipeline — prepare exact Prodigi print-area derivatives from an approved master, upload to R2 + stage rows, verify byte-identity + promote to `ready`, then atomically assign a revision to every active variant; all take `--product`/`--revision`, publish requires `--confirm <revision>`, all support `--dry-run`; need wrangler auth + `SUPABASE_*`, and honour a `PRINT_ASSETS_BUCKET` override from `.dev.vars`/`--env-file`; see `docs/plans/print-asset-pipeline.md` and operator procedures in `docs/print-asset-runbook.md`), `npm run print-assets:gallery` (storefront gallery WebPs from a published fulfilment derivative — uploads to R2 under `prints/{productId}/gallery/{slot}/` and mirrors to `public/uploads/`; `--product` required, optional `--slot`/`--revision`/`--dry-run`), `npm run print-assets:sandbox-matrix` (one Prodigi sandbox order per distinct print-area profile using production signed asset URLs; `--product`, optional `--run-id`/`--dry-run`), `npm run print-asset:smoke` (HEAD probe of a signed print-asset URL against a live origin — redacts `sig` in output; requires `PRINT_ASSET_TOKEN_SECRET` + `SUPABASE_*` + a `ready`/`retired` asset row), `npm run print-fulfilment:check-jobs` / `print-assets:inventory` (Phase 0/6 pre-cutover gates), `npm run reconcile:orders` (backfill missed emails / stuck InPost shipments for prod orders — dry-run by default), `npm run notes:generate` (draft product notes), `npm run i18n:pull` / `i18n:push` / `i18n:check` / `i18n:organize` (sync UI strings with Notion — see `docs/notion-i18n.md`), `npm run gtm:setup` / `gtm:list` / `gtm:key` (Google Tag Manager API), `npm run ga4:report` / `bq:query` (GA4 Data API + BigQuery export reports), `npm run generate-image-variants` (variant-only image optimise), `npm run cf-typegen` (regenerate Cloudflare env types), `npm run cf:dns-cleanup` / `cf:com-redirect` (Cloudflare DNS + `.com→.studio` redirect maintenance), `npm run admin:dev:lan` + `admin:proxy` (run the `/admin` UI over LAN via an nginx reverse proxy — see Admin below).

## Architecture

### Product Registry

Ceramic products are defined statically in `src/lib/products.ts`. The registry is built in two passes: `buildBase()` generates pieces with stable ids, then `buildProducts()` applies the inventory-review diff (`REMOVED` / `RECATEGORISE` / `APPEND_ORDER` / `GALLERY_MERGE`) and assigns display `num` + `noteIndex`. At module load time three lookup structures are built: `PRODUCTS` (array), `PRODUCT_BY_ID` (map), `PRODUCTS_BY_CATEGORY` (map). A `HIDDEN_CATEGORIES` set (currently empty) is the mechanism to withdraw an entire family from the storefront without deleting it. The database (`piece_state` table) is the source of truth only for sold/reserved state — product metadata never lives in the DB.

Each product has: `id` (e.g. `k01`, `v03`), `category` slug, `price` in **PLN złoty** (integer; the EUR price is derived per-category, not stored per-product), image path, dimensions, and a `noteIndex` for i18n content lookup. The `sold` flag is NOT baked in at module load — `getSoldIds()` in `src/lib/inventory.ts` fetches it and is merged at render time on collection pages, product pages, and via `/api/inventory` on the cart page.

**Fine-art prints** are a separate registry in `src/lib/prints.ts` (designs `fap01…`, only the published ones render). Prints are NOT one-of-a-kind — they are print-on-demand variants (size × frame), priced independently (see Fine-Art Prints & Prodigi below).

### Storefront Surfaces

All storefront routes live under `src/app/[locale]/`. Route groups: `(collections)` (grids, has `loading.tsx`) and `(pdp)` (product pages, no `loading.tsx`).

- **Collection pages** — one per ceramic category (`/{category}`), grouped grids of tiles.
- **`/sklep` hub** — every piece grouped by category in a single `GroupedGallery` with a sticky category jump-nav (scroll-spy). The homepage hero is a single "browse all" CTA pointing here; the nav Shop link points here.
- **`/fine-art-prints`** — the prints collection page (its own route under `(collections)`; `fine-art-prints` is a `CategorySlug` deliberately kept out of `CATEGORY_ORDER` so it never renders through ceramic paths).
- **Individual product pages** — `/{category}/{id}` (e.g. `/kubki/k01`) in the `(pdp)` route group; the same group also serves print PDPs. Indexable URLs with SEO metadata, `Product` + `BreadcrumbList` JSON-LD, hreflang across all locales, a two-column layout, gallery, specs, add-to-cart island, and a live "more from this collection" strip. The `(pdp)` group deliberately has **no** `loading.tsx` so `notFound()` returns a real HTTP 404 (a parent Suspense boundary otherwise forces 200).
- **Lightbox** — quick-view modal on tiles; links to the product page permalink. Product photos always render at natural ratio, never cropped.

### Cart

Zustand store in `src/store/cart.ts`, persisted to `localStorage` under key `acc_cart_v1`. The cart is just a Set of tokens — no quantities, no server sync. Ceramic pieces are stored by bare product id; **fine-art prints are stored as `print:<design>:<size>:<framed>:<mount>:<frameColour>` tokens**. Both kinds live in the same cart and are resolved for the UI via `src/lib/cart-lines.ts`. Ceramic cart state is reconciled against live inventory on the checkout page via `/api/inventory`. **A mixed cart (ceramics + prints) cannot be checked out together** — they follow separate fulfilment paths and produce separate orders.

### Checkout Flow (Critical Path)

1. **Client:** User fills delivery details, clicks pay → POST `/api/checkout`
2. **Server (`src/app/api/checkout/route.ts`):**
   - Derives **currency from the `currency_pref` cookie** (via `getCurrency` in `src/lib/currency.server.ts`): `pl → PLN`; other locales use the cookie clamped to a switchable currency (EUR default, GBP), falling back to EUR
   - Validates cart items (`validateCart` in `src/lib/checkout.ts`, currency-aware) and delivery details (`validateDelivery` in `src/lib/shipx.ts`)
   - Calls Supabase RPC `reserve_pieces()` — atomic lock with 15-min TTL; returns conflicting IDs on conflict. An optional **private-sale token** (`src/lib/private-sale.ts`) instead reserves already-sold pieces via `reserve_private_sale_pieces()`
   - Creates Stripe `PaymentIntent` (amount in minor units — grosze for PLN, euro-cents for EUR, pence for GBP) with `payment_method_configuration: STRIPE_PMC_ID` (`pmc_…`, hardcoded constant) — this enables **BLIK / Przelewy24 / Bizum / cards** without per-Dashboard wiring
   - Captures marketing context (cookies, IP, UA, consent) into `orders.marketing` for server-side conversions
   - Persists `orders` + `order_items` rows
   - Returns `client_secret` to client (or `502` with `{ error: 'stripe_failed' }` if PI creation fails)
3. **Client:** Stripe PaymentElement completes payment
4. **Return page (`/koszyk/return`):** Calls `stripe.retrievePaymentIntent()` once on mount via `payment_intent_client_secret` query param; maps status to success/processing/failure — no polling loop

### Webhook Fulfillment

`src/lib/webhook.ts` → `handleStripeEvent()` handles Stripe webhooks at `/api/stripe/webhook` (snapshot / full-payload event destination).

**API-version ritual:** `src/lib/stripe.ts` does not pin `apiVersion`, so the SDK uses the account-default version, and the SDK's generated types track the version bundled with the installed `stripe` package (`^22.2.0` → `2026-05-27.dahlia`). Keep the snapshot webhook endpoint's API version (set in the Stripe Dashboard) matched to that bundled version, and when you bump the `stripe` package update the Dashboard endpoint in lockstep so incoming event payloads stay aligned with the SDK types. (Confirm the exact bundled version from the installed `stripe` package / `package-lock.json` after a bump — it is not inferable from the `^` range in `package.json`.)

Event handling:
- `payment_intent.succeeded` → `markPaid` (idempotent; also sends the customer order-confirmation email + studio new-order email, guarded by `confirmation_email_sent_at`), then `trackPurchase` (server-side Meta CAPI + GA4 MP, consent-gated, skipped unless `order.status = paid`), then `ensureInvoiced` (errors swallowed — Stripe gets 200, no retry), then fulfilment: **ceramic orders** call `createShipment` (InPost; re-throws retryable errors so Stripe retries up to 3 days), **print orders** call `enqueueProdigi()` (`src/server/fulfilment/enqueue.ts`) to push a job onto the Cloudflare Queue for async Prodigi submission
- `payment_intent.payment_failed` / `payment_intent.canceled` → `releaseHold` (frees reserved pieces)
- `charge.refunded` (full refund only) → `releaseSale` (relists pieces)
- `charge.dispute.closed` (lost only) → `releaseSale`

`worker.ts` wraps the OpenNext handler with two extra handlers: a **cron** (every 15 min) that expires abandoned orders older than 1 hour (cancels the Stripe PaymentIntent, frees reserved pieces), and a **queue consumer** that drains the Prodigi fulfilment queue (`src/server/fulfilment/process-job.ts`).

### Fine-Art Prints & Prodigi (print-on-demand)

Prints are fulfilled by **Prodigi**, a POD partner — the store never holds print stock. The integration lives under `src/server/` (third-party fulfilment layer, kept out of `src/lib/`):

- **Catalogue & cart:** `src/lib/prints.ts` (designs), `src/lib/print-cart.ts` (`print:` token encoding + `PRODIGI_SKU_MAP` mapping variants → Prodigi SKUs), `src/lib/print-pricing.ts` and `src/lib/print-shipping.ts` (PLN/EUR/GBP, shipping by EU/UK destination).
- **Print assets:** `src/lib/print-assets.ts` mints **HMAC-signed R2 URLs** for the high-res files Prodigi pulls; served via **`/api/print-assets/[id]`**.
- **Prodigi client:** `src/server/prodigi/` — `client.ts` (`postOrder`/`getOrder`/`getProduct`, sandbox vs live via `PRODIGI_ENV`), `mapper.ts` (`buildProdigiPayload()`), `callbacks.ts`, `types.ts`.
- **Prodigi CLI:** `npm run prodigi -- …` (`scripts/prodigi-cli.ts`) — prefer this for Prodigi API debugging and sandbox operations (SKU lookup, quotes, order inspection/mutations) instead of ad-hoc scripts; full usage in `docs/prodigi-cli.md`. Paid production orders still go through the queue — live `order create` is blocked in the CLI.
- **Queue pipeline:** the Stripe webhook enqueues via `src/server/fulfilment/enqueue.ts` → Cloudflare Queue `prodigi-fulfilment` → `src/server/fulfilment/process-job.ts` submits to Prodigi; `status-map.ts` normalises Prodigi statuses.
- **Callback webhook:** **`/api/webhooks/prodigi/[token]`** receives shipment/status updates, validated against `PRODIGI_CALLBACK_TOKEN`.
- **Sync:** `npm run sync-prodigi-skus` reconciles SKUs into the `pod_variants` table. Design/spec: `docs/superpowers/specs/2026-06-26-fine-art-prints-prodigi-design.md`.

### Admin (Studio dashboard)

A back-office UI lives **outside** the `[locale]` tree at `src/app/admin/` with its own `<html>`/`<body>` (overview KPIs, `orders`, `fulfillment`, `customers`, `inventory`). Server helpers are in `src/lib/admin/` (`data.ts` reads — `listOrders`/`getOrder`/`listInventory` take an optional injected Supabase client, defaulting to `adminSupabase()`; `clients.ts` client factories — `adminSupabase()`/`adminStripe()` build from `getCloudflareContext()`, plus pure `adminSupabaseFromEnv()`/`adminStripeFromEnv()` for callers outside a Workers request; `actions.ts` the four dependency-injected mutations; `fulfillment.ts` queue stages; `money.ts`, `route-helpers.ts`). Mutating actions are exposed under **`/api/admin/*`**: `refund`, `create-shipment`, `label`, `release-reservation`, `resend-confirmation` — each route is a thin adapter over the matching `src/lib/admin/actions.ts` function.

In production every `/admin` and `/api/admin` request is gated by a **Cloudflare Access JWT**, verified in `worker.ts` via `src/lib/admin/access.ts` (path regex `^/admin(/|$)|^/api/admin(/|$)`, checked against `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` and the `ADMIN_ALLOWED_EMAILS` allowlist). Locally the gate is bypassed via `STUDIO_ADMIN_LOCAL_BYPASS`, and `local-admin/` is an nginx reverse proxy (`compose.yaml` → `host.docker.internal:3010`) so the dashboard is reachable over LAN during `npm run admin:dev:lan`.

**Orders CLI:** `npm run orders -- …` (`scripts/orders-cli.ts`) — reads order/inventory/fulfilment state and runs the same four admin mutations as `/api/admin/*` (calling the same `src/lib/admin/actions.ts` functions with its own loaded Supabase/Stripe/InPost clients, built from `.env.local` → `.dev.vars` → `--env-file` → `process.env`, same precedence as `prodigi-cli`). Prefer this over raw SQL or the gated `/admin` UI for routine order debugging. Every mutation requires `--confirm <order-id>` and is blocked against a non-production Supabase project unless `--allow-nonprod` is passed. Full usage in `docs/orders-cli.md`.

### Other API Routes

Beyond `checkout` and `stripe/webhook`, `src/app/api/` exposes:
- **`/api/inventory`** — live sold/reserved IDs for client-side cart reconciliation.
- **`/api/feed/google`** + **`/api/feed/meta`** — Google Shopping & Meta Catalog product feeds, one variant per locale/currency (`FEED_LOCALES` in `src/lib/feed.ts` covers all 4 locales).
- **`/api/private-sale`** — resolves a single-use token to re-offer already-**sold** pieces to a specific buyer. Tokens are minted with `npm run private-sale:create`, stored in `private_sales`, and reserved atomically by `reserve_private_sale_pieces()`. Private-sale links are **ceramics-only** — checkout rejects a token combined with prints (`400 private_sale_prints_unsupported`). Spec: `docs/plans/private-sale-cart-link.md`.
- **`/api/returns`** — creates a return shipment (requires `STUDIO_RETURN_*`).
- **`/api/print-assets/[id]`** — signed high-res print files for Prodigi (see above).
- **`/api/admin/revoke-print-asset`** — emergency-revoke a fulfilment asset (distinct from retire; blocks checkout + returns 410 on the signed route).
- **`/api/webhooks/prodigi/[token]`** — Prodigi status callbacks (see above).
- **`/api/admin/*`** — back-office actions, Cloudflare Access-gated (see Admin above).
- **`/api/inpost/webhook`** + **`/api/resend/webhook`** — delivery-status and email-event receivers.

### Internationalization

Four locales: Polish (default, no prefix), English (`/en`), Spanish (`/es`), German (`/de`). Configured in `src/i18n/routing.ts` (`localePrefix: 'as-needed'`). There is **no separate `gb` locale** — it was merged into `en` (spec `docs/superpowers/specs/2026-07-05-en-gb-locale-merge-design.md`); GBP is a cookie-driven display currency, not a locale. Display currency is decoupled from locale — it comes from the `currency_pref` cookie (see Pricing & Shipping), not the locale. All UI strings — including per-product `notes` — live in `messages/{pl,en,es,de}.json`. Server components use `getTranslations()`, client components use `useTranslations()`. Always import `Link` and `useRouter` from `src/i18n/navigation.ts` (not Next.js directly) to preserve locale.

### Database Schema (Supabase)

- `piece_state`: `product_id` PK, `status` (available|reserved|sold), `reserved_until`, `order_id`
- `orders`: UUID id, `payment_intent_id`, `status` (pending|paid|failed|expired|refunded), totals in minor units, contact JSON, `delivery_method`, `locale`, `currency` (pln|eur|gbp), `marketing` (jsonb — server-conversion context), `confirmation_email_sent_at`, `private_sale_id` (nullable FK)
- `order_items`: `order_id`, `product_id`, `unit_price` (minor units, in the order's currency)
- `private_sales`: `id`, `token`, `product_ids`, `expires_at`, `consumed_at` — single-use re-sale links for sold pieces (one paid order per token, enforced by a partial unique index)
- `fulfilment_jobs` + `prodigi_orders`: async print-fulfilment queue state and the Prodigi order records it produces (migration `supabase/migrations/20260626120002_fulfilment_jobs.sql`)
- `pod_variants`: print-on-demand SKU catalogue (design × size × frame → Prodigi SKU), reconciled by `npm run sync-prodigi-skus`
- `reserve_pieces()` RPC: atomically reserves rows; returns array of conflicting product IDs (empty = success). `reserve_private_sale_pieces()` does the same for sold pieces behind a valid token

RLS is enabled; all server-side code uses the service-role key (`getSupabaseAdmin()`).

### Pricing & Shipping

Multi-currency, defined in `src/lib/pricing.ts`. `PRICE_PLN`, `PRICE_EUR`, and `PRICE_GBP` give per-category prices (whole units); `priceOfCurrency(product, currency)` returns the display price in a given currency. The display currency comes from the `currency_pref` cookie (`src/lib/currency.ts` / server reader `getCurrency` in `currency.server.ts`), not the locale: `pl → PLN`; other locales default to EUR and can switch to GBP, seeded from `CF-IPCountry` and clamped to a switchable currency. Conversion to minor units happens at checkout via `toGrosze()` (PLN×100) / `toEuroCents()` (EUR×100) / `toGBPPence()` (GBP×100). Shipping: Paczkomat **20 zł / 5 € / 5 £**, Kurier **30 zł / 10 € / 12 £**, Odbiór osobisty (Warsaw) **0** (`SHIPPING_PLN` / `SHIPPING_EUR` / `SHIPPING_GBP`). Delivery details are validated in `src/lib/shipx.ts` (`validateDelivery()`). InPost Geowidget (v5 custom element) is rendered in `src/components/shop/GeowidgetPicker.tsx` for locker selection. **Prints price and ship independently** of ceramics — see `src/lib/print-pricing.ts` (per size × frame, PLN/EUR/GBP) and `src/lib/print-shipping.ts` (by EU/UK destination); they always ship to a home address, never a locker.

### Analytics & Conversions

- **Client (browser):** GA4 + Meta Pixel via Google Tag Manager, gated by Consent Mode v2 (default-deny until the banner is accepted). Ecommerce events use major-currency values (never grosze) and locale-correct currency. Custom GA4 funnel/demand events route through a single `site_engagement` event keyed by `engagement_type` (delivery-method selects, locker selected, `sold_item_view`, `checkout_error`, `payment_failed`).
- **Server-side:** `src/lib/marketing/` sends Purchase to the **Meta Conversions API** (`meta-capi.ts`) and **GA4 Measurement Protocol** (`ga4-mp.ts`) from the webhook (`conversions.ts`), consent-gated, with SHA-256 hashed match data (`hash.ts`) captured at checkout (`context.ts`, `client-cookies.ts`). The browser and server share a **deterministic `purchase` event_id** — `purchase-<payment_intent_id>` (the browser defaults `orderNo` to the PaymentIntent id on `/koszyk/return`; server CAPI in `conversions.ts` uses the same key) — so the two are deduplicated. ⚠️ Passing a distinct client `orderNo` without updating `conversions.ts` breaks dedup. See `docs/analytics-stack.md`.

### Environment Variables

**Build-time** (`NEXT_PUBLIC_*` — set as Workers Build env vars, NOT wrangler secrets):
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — Stripe Payment Element
- `NEXT_PUBLIC_GTM_ID` — Google Tag Manager
- `NEXT_PUBLIC_GA4_MEASUREMENT_ID` / `NEXT_PUBLIC_META_PIXEL_ID` — client analytics ids
- `NEXT_PUBLIC_SENTRY_DSN` — client-side error monitoring
- `NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN` / `NEXT_PUBLIC_INPOST_GEOWIDGET_ENV` — locker picker

**Runtime secrets** (set with `wrangler secret put` in prod, `.dev.vars` locally):
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
- `INPOST_API_TOKEN` / `INPOST_ORGANIZATION_ID` / `INPOST_API_URL` / `INPOST_WEBHOOK_TOKEN`
- `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET` / `STUDIO_NOTIFY_EMAIL` / `SENTRY_DSN`
- `META_CAPI_ACCESS_TOKEN` / `GA4_API_SECRET` (+ optional `META_TEST_EVENT_CODE`) — server-side conversions
- `STUDIO_RETURN_*` — return shipment address (required for `/api/returns`)
- `PRODIGI_API_KEY_SANDBOX` / `PRODIGI_API_KEY_LIVE` / `PRODIGI_ENV` / `PRODIGI_CALLBACK_TOKEN` / `PRODIGI_DEFAULT_SHIPPING_METHOD` — print-on-demand fulfilment; `PRINT_ASSET_TOKEN_SECRET` signs the `/api/print-assets/[id]` URLs Prodigi pulls from
- `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` / `ADMIN_ALLOWED_EMAILS` — Cloudflare Access gate for `/admin` (+ `STUDIO_ADMIN_LOCAL_BYPASS` to skip it in local dev)
- `CMS_PREVIEW_SECRET` — dedicated HMAC secret for admin draft-preview tokens (`/api/admin/content/preview` → `?preview=` on PDPs). Fail-closed: must be set or preview minting 500s; never reuse Stripe/Supabase secrets. The publish path is atomic via the `publish_cms_version()` RPC (migration `20260709120000`); notes are keyed by product id, not array position.

See `.env.example` for the full list and setup notes. See `docs/cloudflare-deployment.md` for Workers Builds CI configuration and `docs/analytics-stack.md` for the analytics/conversion event contract.

## Key Conventions

**Monetary values:** PLN in grosze, EUR in euro-cents, GBP in pence — always integers. Use `pln()` from `src/lib/format.ts` for PLN display, and `priceOf(product, locale)` to pick the right currency/value for a locale. Grosze/euro-cents are a checkout/Stripe-only rule; the analytics layer uses major units.

**Server vs client components:** Default to server components (async). Add `'use client'` only when needed for state, hooks, or browser APIs. Secrets (Stripe, Supabase admin, conversion tokens) are never exposed to the client — all sensitive operations go through API routes or the webhook.

**Product IDs:** Single-letter category prefix + zero-padded number (`k01` = kubki 01). The `id` is a STABLE token — it never renumbers when the catalogue is cut; the display `num` and `category` may change via the inventory-review diff in `products.ts`. Ceramic category slugs (9): `kubki`, `wazony`, `wazony-srednie`, `wazony-duze`, `talerzyki`, `talerze-srednie`, `talerze-duze`, `duze-michy`, `miski-falowane`. A 10th `CategorySlug`, `fine-art-prints`, is the POD prints surface — it is intentionally excluded from `CATEGORY_ORDER` so ceramic code paths ignore it.

**Code layers:** `src/lib/` holds domain/business logic (products, pricing, checkout, marketing). `src/server/` holds third-party fulfilment integration (Prodigi client + the Cloudflare Queue pipeline). `src/app/admin/` and `src/lib/admin/` are the back-office, gated by Cloudflare Access in production.

**CSS:** Token-driven via custom properties in `src/styles/tokens.css` (`--c-*` colors, `--f-*` fonts, `--gut` gutter, `--section-y` spacing, `--r-*` radii). No CSS-in-JS — plain CSS files colocated with components or in `src/styles/`.

**Responsive images:** Use `srcSet()` from `src/lib/images.ts` for product images (native `<img>`, not `next/image` — see SEO note). All product images are WebP in `public/uploads/`, generated from gitignored `design/uploads/` via `npm run optimize-images`.

**API error responses:** `NextResponse.json({ error: reason }, { status: code })`. Checkout returns 400 (validation), including `{ error: 'private_sale_prints_unsupported' }` when a private-sale token is sent with a print cart, 409 with `{ error: 'unavailable', sold: string[] }` (pieces unavailable), 409 `{ error: 'order_conflict' }` (stale attemptId — client must reset it), 409 `{ error: 'checkout_in_progress' }` (a concurrent or unresolvable POST for the same attemptId — client must KEEP the attemptId and retry), 409 `{ error: 'print_asset_unavailable' }` (no ready/usable print asset for the requested variant — runs before reservation/PI), 502 with `{ error: 'stripe_failed' }` (Stripe PI creation failure), 503 `{ error: 'print_asset_error' }` (transient Supabase failure resolving the print asset — safe to retry, before any reservation/PI), 500 (other server faults).

**Analytics:** Fire `begin_checkout` when the user clicks pay in `CartView` (before POST `/api/checkout`). Fire deduplicated `purchase` and `payment_failed` events on the return page (keyed by `payment_intent` ID via sessionStorage to prevent double-counting on refresh).

**Build system:** Always use webpack — never Turbopack. The `build` script in `package.json` must stay as `next build --webpack`. OpenNext cannot load Turbopack chunks at the Cloudflare Workers runtime (causes ChunkLoadError → HTTP 500 on every page). Do not remove `--webpack`, do not add `--turbo`, do not suggest switching to Turbopack for any reason.

## Deployment

Cloudflare Workers via OpenNext (`open-next.config.ts`). Preview locally with `npm run preview:cf`. Workers Builds CI handles production deploys on push to main.

Key `wrangler.jsonc` bindings: `ASSETS` (static assets from `.open-next/assets`), `WORKER_SELF_REFERENCE` service binding (self-reference for cache purging), `FULFILMENT_QUEUE` (Cloudflare Queue `prodigi-fulfilment`), `PRINT_ASSETS` (R2 bucket for high-res print files), and a cron trigger every 15 min.

`worker.ts` wraps the OpenNext handler and adds the cron scheduled handler, the Prodigi **queue consumer**, and the Cloudflare Access gate for `/admin`. It **must** re-export `DOQueueHandler`, `DOShardedTagCache`, and `BucketCachePurge` from `.open-next/worker.js` — omitting these breaks deployment.

`src/middleware.ts` must **not** be renamed to `proxy.ts`: OpenNext only bundles edge-runtime middleware, but Next 16's `proxy.ts` is Node-runtime only and OpenNext rejects it, breaking the Cloudflare build (`next build` alone does not catch this). See `docs/superpowers/plans/2026-06-08-go-to-market-execution.md` (Task 8, cancelled).

New migrations go in `supabase/migrations/` with timestamp prefix. Docs for deployment, E2E testing design, and analytics setup are in `docs/`.
