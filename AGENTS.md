# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, Copilot, …) working in this repository. This is the **canonical** project context file; Claude Code reads it via an `@AGENTS.md` import in `CLAUDE.md`.

## Project Overview

An e-commerce storefront for one-of-a-kind ceramic pieces by Anna Ciok. Built with Next.js 16 App Router, deployed on Cloudflare Workers via OpenNext. All products are unique (no quantities) — once sold, they're gone. The catalogue is **~104 live pieces across 9 categories** (the June inventory review cut it to 78, then subsequent drops added talerzyki, a new `talerze-srednie` family, and a few extra pieces). **Five locales** (Polish default at unprefixed `/`, plus `/en` `/es` `/de` `/gb`) and **tri-currency** (PLN for `pl`, GBP for `gb`, EUR for `en`/`es`/`de`). Live at [anna-ciok.studio](https://anna-ciok.studio).

## Commands

```bash
npm run dev           # Local dev server
npm run build         # Production build (next build --webpack — see Build system)
npm run lint          # ESLint
npm run test          # Vitest unit tests (src/**/*.test.ts)
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

Operational / one-off scripts (full list in `package.json`): `npm run private-sale:create` (mint a re-sale link for sold pieces), `npm run notes:generate` (draft product notes), `npm run i18n:pull` / `i18n:push` (sync UI strings with Notion — see `docs/notion-i18n.md`), `npm run gtm:setup` / `gtm:list` (Google Tag Manager API), `npm run generate-image-variants` (variant-only image optimise), `npm run cf-typegen` (regenerate Cloudflare env types).

## Architecture

### Product Registry

All products are defined statically in `src/lib/products.ts`. The registry is built in two passes: `buildBase()` generates pieces with stable ids, then `buildProducts()` applies the inventory-review diff (`REMOVED` / `RECATEGORISE` / `APPEND_ORDER` / `GALLERY_MERGE`) and assigns display `num` + `noteIndex`. At module load time three lookup structures are built: `PRODUCTS` (array), `PRODUCT_BY_ID` (map), `PRODUCTS_BY_CATEGORY` (map). The database (`piece_state` table) is the source of truth only for sold/reserved state — product metadata never lives in the DB.

Each product has: `id` (e.g. `k01`, `v03`), `category` slug, `price` in **PLN złoty** (integer; the EUR price is derived per-category, not stored per-product), image path, dimensions, and a `noteIndex` for i18n content lookup. The `sold` flag is NOT baked in at module load — `getSoldIds()` in `src/lib/inventory.ts` fetches it and is merged at render time on collection pages, product pages, and via `/api/inventory` on the cart page.

### Storefront Surfaces

- **Collection pages** — one per category (`/{category}`), grouped grids of tiles.
- **`/sklep` hub** — every piece grouped by category in a single `GroupedGallery` with a sticky category jump-nav (scroll-spy). The homepage hero is a single "browse all" CTA pointing here; the nav Shop link points here.
- **Individual product pages** — `/{category}/{id}` (e.g. `/kubki/k01`) in the `(pdp)` route group. Indexable URLs with SEO metadata, `Product` + `BreadcrumbList` JSON-LD, hreflang across all locales, a two-column layout, gallery, specs, add-to-cart island, and a live "more from this collection" strip. The `(pdp)` group deliberately has **no** `loading.tsx` so `notFound()` returns a real HTTP 404 (a parent Suspense boundary otherwise forces 200).
- **Lightbox** — quick-view modal on tiles; links to the product page permalink. Product photos always render at natural ratio, never cropped.

### Cart

Zustand store in `src/store/cart.ts`, persisted to `localStorage` under key `acc_cart_v1`. The cart is just a Set of product IDs — no quantities, no server sync. The cart state is always reconciled against live inventory on the checkout page via `/api/inventory`.

### Checkout Flow (Critical Path)

1. **Client:** User fills delivery details, clicks pay → POST `/api/checkout`
2. **Server (`src/app/api/checkout/route.ts`):**
   - Derives **currency from locale**: `pl → PLN`, `gb → GBP`, `en`/`es`/`de → EUR`
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
- `payment_intent.succeeded` → `markPaid` (idempotent; also sends the customer order-confirmation email + studio new-order email, guarded by `confirmation_email_sent_at`), then `trackPurchase` (server-side Meta CAPI + GA4 MP, consent-gated, skipped unless `order.status = paid`), then `ensureInvoiced` (errors swallowed — Stripe gets 200, no retry), then `createShipment` (re-throws retryable errors so Stripe retries up to 3 days)
- `payment_intent.payment_failed` / `payment_intent.canceled` → `releaseHold` (frees reserved pieces)
- `charge.refunded` (full refund only) → `releaseSale` (relists pieces)
- `charge.dispute.closed` (lost only) → `releaseSale`

A Cloudflare Worker cron (`worker.ts`, every 15 min) expires abandoned orders older than 1 hour: cancels the Stripe PaymentIntent and frees reserved pieces.

### Other API Routes

Beyond `checkout` and `stripe/webhook`, `src/app/api/` exposes:
- **`/api/inventory`** — live sold/reserved IDs for client-side cart reconciliation.
- **`/api/feed/google`** + **`/api/feed/meta`** — Google Shopping & Meta Catalog product feeds, one variant per locale/currency (`FEED_LOCALES` in `src/lib/feed.ts` covers all 5 locales).
- **`/api/private-sale`** — resolves a single-use token to re-offer already-**sold** pieces to a specific buyer. Tokens are minted with `npm run private-sale:create`, stored in `private_sales`, and reserved atomically by `reserve_private_sale_pieces()`. Spec: `docs/plans/private-sale-cart-link.md`.
- **`/api/returns`** — creates a return shipment (requires `STUDIO_RETURN_*`).
- **`/api/inpost/webhook`** + **`/api/resend/webhook`** — delivery-status and email-event receivers.

### Internationalization

Five locales: Polish (default, no prefix), English (`/en`), Spanish (`/es`), German (`/de`), British English (`/gb`). Configured in `src/i18n/routing.ts` (`localePrefix: 'as-needed'`). All UI strings — including per-product `notes` — live in `messages/{pl,en,es,de,gb}.json`. Server components use `getTranslations()`, client components use `useTranslations()`. Always import `Link` and `useRouter` from `src/i18n/navigation.ts` (not Next.js directly) to preserve locale.

### Database Schema (Supabase)

- `piece_state`: `product_id` PK, `status` (available|reserved|sold), `reserved_until`, `order_id`
- `orders`: UUID id, `payment_intent_id`, `status` (pending|paid|failed|expired|refunded), totals in minor units, contact JSON, `delivery_method`, `locale`, `currency` (pln|eur|gbp), `marketing` (jsonb — server-conversion context), `confirmation_email_sent_at`, `private_sale_id` (nullable FK)
- `order_items`: `order_id`, `product_id`, `unit_price` (minor units, in the order's currency)
- `private_sales`: `id`, `token`, `product_ids`, `expires_at`, `consumed_at` — single-use re-sale links for sold pieces (one paid order per token, enforced by a partial unique index)
- `reserve_pieces()` RPC: atomically reserves rows; returns array of conflicting product IDs (empty = success). `reserve_private_sale_pieces()` does the same for sold pieces behind a valid token

RLS is enabled; all server-side code uses the service-role key (`getSupabaseAdmin()`).

### Pricing & Shipping

Tri-currency, defined in `src/lib/pricing.ts`. `PRICE_PLN`, `PRICE_EUR`, and `PRICE_GBP` give per-category prices (whole units); `priceOf(product, locale)` returns the display price in the right currency (`pl → PLN`, `gb → GBP`, otherwise EUR). Conversion to minor units happens at checkout via `toGrosze()` (PLN×100) / `toEuroCents()` (EUR×100) / `toGBPPence()` (GBP×100). Shipping: Paczkomat **20 zł / 5 € / 5 £**, Kurier **30 zł / 10 € / 12 £**, Odbiór osobisty (Warsaw) **0** (`SHIPPING_PLN` / `SHIPPING_EUR` / `SHIPPING_GBP`). Delivery details are validated in `src/lib/shipx.ts` (`validateDelivery()`). InPost Geowidget (v5 custom element) is rendered in `src/components/shop/GeowidgetPicker.tsx` for locker selection.

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

See `.env.example` for the full list and setup notes. See `docs/cloudflare-deployment.md` for Workers Builds CI configuration and `docs/analytics-stack.md` for the analytics/conversion event contract.

## Key Conventions

**Monetary values:** PLN in grosze, EUR in euro-cents, GBP in pence — always integers. Use `pln()` from `src/lib/format.ts` for PLN display, and `priceOf(product, locale)` to pick the right currency/value for a locale. Grosze/euro-cents are a checkout/Stripe-only rule; the analytics layer uses major units.

**Server vs client components:** Default to server components (async). Add `'use client'` only when needed for state, hooks, or browser APIs. Secrets (Stripe, Supabase admin, conversion tokens) are never exposed to the client — all sensitive operations go through API routes or the webhook.

**Product IDs:** Single-letter category prefix + zero-padded number (`k01` = kubki 01). The `id` is a STABLE token — it never renumbers when the catalogue is cut; the display `num` and `category` may change via the inventory-review diff in `products.ts`. Category slugs (9): `kubki`, `wazony`, `wazony-srednie`, `wazony-duze`, `talerzyki`, `talerze-srednie`, `talerze-duze`, `duze-michy`, `miski-falowane`.

**CSS:** Token-driven via custom properties in `src/styles/tokens.css` (`--c-*` colors, `--f-*` fonts, `--gut` gutter, `--section-y` spacing, `--r-*` radii). No CSS-in-JS — plain CSS files colocated with components or in `src/styles/`.

**Responsive images:** Use `srcSet()` from `src/lib/images.ts` for product images (native `<img>`, not `next/image` — see SEO note). All product images are WebP in `public/uploads/`, generated from gitignored `design/uploads/` via `npm run optimize-images`.

**API error responses:** `NextResponse.json({ error: reason }, { status: code })`. Checkout returns 400 (validation), 409 with `{ error: 'unavailable', sold: string[] }` (pieces unavailable), 502 with `{ error: 'stripe_failed' }` (Stripe PI creation failure), 500 (other server faults).

**Analytics:** Fire `begin_checkout` when the user clicks pay in `CartView` (before POST `/api/checkout`). Fire deduplicated `purchase` and `payment_failed` events on the return page (keyed by `payment_intent` ID via sessionStorage to prevent double-counting on refresh).

**Build system:** Always use webpack — never Turbopack. The `build` script in `package.json` must stay as `next build --webpack`. OpenNext cannot load Turbopack chunks at the Cloudflare Workers runtime (causes ChunkLoadError → HTTP 500 on every page). Do not remove `--webpack`, do not add `--turbo`, do not suggest switching to Turbopack for any reason.

## Deployment

Cloudflare Workers via OpenNext (`open-next.config.ts`). Preview locally with `npm run preview:cf`. Workers Builds CI handles production deploys on push to main.

Key `wrangler.jsonc` bindings: `ASSETS` (static assets from `.open-next/assets`), `WORKER_SELF_REFERENCE` service binding (self-reference for cache purging), cron trigger every 15 min.

`worker.ts` wraps the OpenNext handler and adds the cron scheduled handler. It **must** re-export `DOQueueHandler`, `DOShardedTagCache`, and `BucketCachePurge` from `.open-next/worker.js` — omitting these breaks deployment.

`middleware.ts` must **not** be renamed to `proxy.ts`: OpenNext only bundles edge-runtime middleware, but Next 16's `proxy.ts` is Node-runtime only and OpenNext rejects it, breaking the Cloudflare build (`next build` alone does not catch this). See `docs/superpowers/plans/2026-06-08-go-to-market-execution.md` (Task 8, cancelled).

New migrations go in `supabase/migrations/` with timestamp prefix. Docs for deployment, E2E testing design, and analytics setup are in `docs/`.

## Cursor Cloud specific instructions

The startup update script runs `npm ci` (Node 22 / npm 10.9 are preinstalled). Standard commands live in **Commands** above — use those; the notes below are only the non-obvious gotchas for running this app in the cloud VM.

- **No secrets are needed to run the storefront.** `npm run dev` (`:3000`) serves the full catalogue with **zero** env files — products come from the static registry in `src/lib/products.ts`. Without Supabase configured, sold/reserved state degrades gracefully: `GET /api/inventory` returns `{"sold":[]}` and every piece shows as available. Browsing, the `/sklep` hub, product pages, and the cart all work offline.
- **What does require secrets.** Real checkout (`/api/checkout` → Stripe Payment Element), webhook fulfillment, and the `/admin/*` Studio surface need credentials. Put `NEXT_PUBLIC_*` (Stripe publishable key, Geowidget token/env) in `.env.local` (inlined at build time) and runtime secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `INPOST_*`) in `.dev.vars` — `next.config.ts` bridges `.dev.vars` into `next dev` via `initOpenNextCloudflareForDev()`. Admin auth can be bypassed locally with `STUDIO_ADMIN_LOCAL_BYPASS=true` in `.dev.vars` (never in prod). There is **no local Supabase stack** (no `supabase/config.toml`); migrations target a hosted project.
- **`npm run dev` uses Turbopack** (Next 16 default) — this is fine for dev. The webpack-only rule applies **only** to `npm run build` (`next build --webpack`); never add `--turbo` to the build (see Build system above).
- **Benign startup warnings:** the `"middleware" file convention is deprecated … use "proxy"` warning is expected — do **not** rename `middleware.ts` to `proxy.ts` (it breaks the OpenNext/Cloudflare build, see Deployment). The npm audit warnings on install are also expected.
- **E2E tests target production by default.** `npm run test:e2e` points at `https://anna-ciok.studio`. For a hermetic local run, first `npx playwright install` (browsers are not in the update script), then `PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run test:e2e` — Playwright will `npm run build` + `npm run start` itself. `@destructive` specs are excluded unless `E2E_DESTRUCTIVE=1`.
