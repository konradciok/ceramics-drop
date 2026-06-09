# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An e-commerce storefront for one-of-a-kind ceramic pieces by Anna Ciok. Built with Next.js 16 App Router, deployed on Cloudflare Workers via OpenNext. All products are unique (no quantities) — once sold, they're gone. The June inventory review cut the catalogue to 78 standalone pieces. Live at [anna-ciok.studio](https://anna-ciok.studio).

## Commands

```bash
npm run dev           # Local dev server
npm run build         # Production build (static pre-render)
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

## Architecture

### Product Registry

All products are defined statically in `src/lib/products.ts`. The registry is built in two passes: `buildBase()` generates pieces with stable ids, then `buildProducts()` applies the inventory-review diff (`REMOVED` / `RECATEGORISE` / `APPEND_ORDER` / `GALLERY_MERGE`) and assigns display `num` + `noteIndex`. At module load time three lookup structures are built: `PRODUCTS` (array), `PRODUCT_BY_ID` (map), `PRODUCTS_BY_CATEGORY` (map). The database (`piece_state` table) is the source of truth only for sold/reserved state — product metadata never lives in the DB.

Each product has: `id` (e.g. `k01`, `v03`), `category` slug, `price` in PLN złoty (integer; converted to grosze at checkout via `toGrosze()`), image path, dimensions, and a `noteIndex` for i18n content lookup. The `sold` flag is NOT baked in at module load — `getSoldIds()` in `src/lib/inventory.ts` fetches it and is merged at render time on collection pages and via `/api/inventory` on the cart page.

### Cart

Zustand store in `src/store/cart.ts`, persisted to `localStorage` under key `acc_cart_v1`. The cart is just a Set of product IDs — no quantities, no server sync. The cart state is always reconciled against live inventory on the checkout page via `/api/inventory`.

### Checkout Flow (Critical Path)

1. **Client:** User fills delivery details, clicks pay → POST `/api/checkout`
2. **Server (`src/app/api/checkout/route.ts`):**
   - Validates cart items (`validateCart` in `src/lib/checkout.ts`) and delivery details (`validateDelivery` in `src/lib/shipx.ts`)
   - Calls Supabase RPC `reserve_pieces()` — atomic lock with 15-min TTL; returns conflicting IDs on conflict
   - Creates Stripe `PaymentIntent` (currency: PLN, amount in grosze)
   - Persists `orders` + `order_items` rows
   - Returns `client_secret` to client (or `502` with `{ error: 'stripe_failed' }` if PI creation fails)
3. **Client:** Stripe PaymentElement completes payment
4. **Return page (`/koszyk/return`):** Calls `stripe.retrievePaymentIntent()` once on mount via `payment_intent_client_secret` query param; maps status to success/processing/failure — no polling loop

### Webhook Fulfillment

`src/lib/webhook.ts` → `handleStripeEvent()` handles Stripe webhooks at `/api/stripe/webhook`. There is also a thin ACK-only handler at `/api/stripe/webhook-thin` (uses `STRIPE_WEBHOOK_THIN_SECRET`).

Event handling:
- `payment_intent.succeeded` → `markPaid` (idempotent), then `ensureInvoiced` (errors swallowed — Stripe gets 200, no retry), then `createShipment` (re-throws retryable errors so Stripe retries up to 3 days)
- `payment_intent.payment_failed` / `payment_intent.canceled` → `releaseHold` (frees reserved pieces)
- `charge.refunded` (full refund only) → `releaseSale` (relists pieces)
- `charge.dispute.closed` (lost only) → `releaseSale`

A Cloudflare Worker cron (`worker.ts`, every 15 min) expires abandoned orders older than 1 hour: cancels the Stripe PaymentIntent and frees reserved pieces.

### Internationalization

Trilingual: Polish (default, no prefix), English (`/en`), Spanish (`/es`). Configured in `src/i18n/routing.ts`. All UI strings live in `messages/{pl,en,es}.json`. Server components use `getTranslations()`, client components use `useTranslations()`. Always import `Link` and `useRouter` from `src/i18n/navigation.ts` (not Next.js directly) to preserve locale.

### Database Schema (Supabase)

- `piece_state`: `product_id` PK, `status` (available|reserved|sold), `reserved_until`, `order_id`
- `orders`: UUID id, `payment_intent_id`, `status` (pending|paid|failed|expired|refunded), totals in grosze, contact JSON, `delivery_method`, `locale`
- `order_items`: `order_id`, `product_id`, `unit_price` (grosze)
- `reserve_pieces()` RPC: atomically reserves rows; returns array of conflicting product IDs (empty = success)

RLS is enabled; all server-side code uses the service-role key (`getSupabaseAdmin()`).

### Pricing & Shipping

All monetary values are integers in grosze (PLN×100). `src/lib/pricing.ts` defines per-category PLN prices (`PRICE_PLN`) and `orderAmountGrosze()`. Conversion to grosze happens at checkout via `toGrosze()`. Shipping methods: Paczkomat 1500 grosze, kurier 7500 grosze, odbiór osobisty 0. Delivery details are validated in `src/lib/shipx.ts` (`validateDelivery()`). InPost Geowidget (v5 custom element) is rendered in `src/components/shop/GeowidgetPicker.tsx` for locker selection.

### Environment Variables

**Build-time** (`NEXT_PUBLIC_*` — set as Workers Build env vars, NOT wrangler secrets):
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — Stripe Payment Element
- `NEXT_PUBLIC_GTM_ID` — Google Tag Manager
- `NEXT_PUBLIC_SENTRY_DSN` — client-side error monitoring
- `NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN` / `NEXT_PUBLIC_INPOST_GEOWIDGET_ENV` — locker picker

**Runtime secrets** (set with `wrangler secret put` in prod, `.dev.vars` locally):
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_WEBHOOK_THIN_SECRET`
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
- `INPOST_API_TOKEN` / `INPOST_ORGANIZATION_ID` / `INPOST_API_URL` / `INPOST_WEBHOOK_TOKEN`
- `RESEND_API_KEY` / `STUDIO_NOTIFY_EMAIL` / `SENTRY_DSN`
- `STUDIO_RETURN_*` — return shipment address (required for `/api/returns`)

See `.env.example` for the full list and setup notes. See `docs/cloudflare-deployment.md` for Workers Builds CI configuration.

## Key Conventions

**Monetary values:** Always integers in grosze. Use `pln()` from `src/lib/format.ts` for display.

**Server vs client components:** Default to server components (async). Add `'use client'` only when needed for state, hooks, or browser APIs. Secrets (Stripe, Supabase admin) are never exposed to the client — all sensitive operations go through API routes.

**Product IDs:** Single-letter category prefix + zero-padded number (`k01` = kubki 01). The `id` is a STABLE token — it never renumbers when the catalogue is cut; the display `num` and `category` may change via the inventory-review diff in `products.ts`. Category slugs: `kubki`, `wazony`, `wazony-srednie`, `wazony-duze`, `talerzyki`, `talerze-duze`, `duze-michy`, `miski-falowane`.

**CSS:** Token-driven via custom properties in `src/styles/tokens.css` (`--c-*` colors, `--f-*` fonts, `--gut` gutter, `--section-y` spacing, `--r-*` radii). No CSS-in-JS — plain CSS files colocated with components or in `src/styles/`.

**Responsive images:** Use `srcSet()` from `src/lib/images.ts` for product images. All product images are WebP in `public/uploads/`.

**API error responses:** `NextResponse.json({ error: reason }, { status: code })`. Checkout returns 400 (validation), 409 with `{ error: 'unavailable', sold: string[] }` (pieces unavailable), 502 with `{ error: 'stripe_failed' }` (Stripe PI creation failure), 500 (other server faults).

**Analytics:** Fire `begin_checkout` when the user clicks pay in `CartView` (before POST `/api/checkout`). Fire deduplicated `purchase` event on return page (keyed by `payment_intent` ID to prevent double-counting on refresh).

## Deployment

Cloudflare Workers via OpenNext (`open-next.config.ts`). Preview locally with `npm run preview:cf`. Workers Builds CI handles production deploys on push to main.

Key `wrangler.jsonc` bindings: `ASSETS` (static assets from `.open-next/assets`), `WORKER_SELF_REFERENCE` service binding (self-reference for cache purging), cron trigger every 15 min.

`worker.ts` wraps the OpenNext handler and adds the cron scheduled handler. It **must** re-export `DOQueueHandler`, `DOShardedTagCache`, and `BucketCachePurge` from `.open-next/worker.js` — omitting these breaks deployment.

New migrations go in `supabase/migrations/` with timestamp prefix. Docs for deployment, E2E testing design, and analytics setup are in `docs/`.
