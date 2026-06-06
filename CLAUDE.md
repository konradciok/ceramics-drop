# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An e-commerce storefront for one-of-a-kind ceramic pieces by Anna Ciok. Built with Next.js 16 App Router, deployed on Cloudflare Workers via OpenNext. All 88 products are unique (no quantities) — once sold, they're gone. Live at [anna-ciok.studio](https://anna-ciok.studio).

## Commands

```bash
npm run dev           # Local dev server
npm run build         # Production build (static pre-render)
npm run lint          # ESLint
npm run test          # Vitest unit tests (src/**/*.test.ts)
npm run test:e2e      # Playwright E2E (@ci specs) — runs against deployed site by default
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

All 88 products are defined statically in `src/lib/products.ts`. At module load time, three lookup structures are built: `PRODUCTS` (array), `PRODUCT_BY_ID` (map), `PRODUCTS_BY_CATEGORY` (map). The database (`piece_state` table) is the source of truth only for sold/reserved state — product metadata never lives in the DB.

Each product has: `id` (e.g. `k01`, `v03`), `category` slug, `price` in EUR (stored as integer grosze = EUR×100), image path, dimensions, a `noteIndex` for i18n content lookup, and a `sold` flag (seeded from DB via `getSoldIds()`).

### Cart

Zustand store in `src/store/cart.ts`, persisted to `localStorage` under key `acc_cart_v1`. The cart is just a Set of product IDs — no quantities, no server sync. The cart state is always reconciled against live inventory on the checkout page via `/api/inventory`.

### Checkout Flow (Critical Path)

1. **Client:** User fills delivery details, clicks pay → POST `/api/checkout`
2. **Server (`src/app/api/checkout/route.ts`):**
   - Validates cart items (`validateCart`) and delivery details (`validateDelivery`)
   - Calls Supabase RPC `reserve_pieces()` — atomic lock with 15-min TTL; returns conflicting IDs on conflict
   - Creates Stripe `PaymentIntent` (currency: PLN, amount in grosze)
   - Persists `orders` + `order_items` rows
   - Returns `client_secret` to client
3. **Client:** Stripe PaymentElement completes payment
4. **Return page (`/koszyk/return`):** Polls Stripe for `payment_intent` status, shows success/failure

### Webhook Fulfillment

`src/lib/webhook.ts` → `handleStripeEvent()` handles Stripe webhooks at `/api/stripe/webhook`. On `payment_intent.succeeded`:
- Marks order `paid`, updates `piece_state` to `sold` (idempotent — safe to retry)
- Validates piece count; if mismatch → issues refund + marks order `failed`
- Sends invoice email via Resend
- Creates InPost shipment via ShipX API

A Cloudflare Worker cron (`worker.ts`, every 15 min) expires abandoned orders older than 1 hour: cancels the Stripe PaymentIntent and frees reserved pieces.

### Internationalization

Trilingual: Polish (default, no prefix), English (`/en`), Spanish (`/es`). Configured in `src/i18n/routing.ts`. All UI strings live in `messages/{pl,en,es}.json`. Server components use `getTranslations()`, client components use `useTranslations()`. Always import `Link` and `useRouter` from `src/i18n/navigation.ts` (not Next.js directly) to preserve locale.

### Database Schema (Supabase)

- `piece_state`: `product_id` PK, `status` (available|reserved|sold), `reserved_until`, `order_id`
- `orders`: UUID id, `payment_intent_id`, `status` (pending|paid|failed|expired), totals in grosze, contact JSON, `delivery_method`, `locale`
- `order_items`: `order_id`, `product_id`, `unit_price` (grosze)
- `reserve_pieces()` RPC: atomically reserves rows; returns array of conflicting product IDs (empty = success)

RLS is enabled; all server-side code uses the service-role key (`getSupabaseAdmin()`).

### Pricing & Shipping

All monetary values are integers in grosze (PLN×100). `src/lib/pricing.ts` defines per-category EUR prices and `orderAmountGrosze()`. Shipping methods: Paczkomat 1500 grosze, kurier 7500 grosze, odbiór osobisty 0. Delivery details are validated in `src/lib/inpost.ts` (`validateDelivery()`). InPost Geowidget (v5 custom element) is rendered in `GeowidgetPicker.tsx` for locker selection.

### Key Environment Variables

- `STRIPE_SECRET_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — Stripe
- `STRIPE_WEBHOOK_SECRET` — webhook signature verification
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — Supabase admin access
- `INPOST_API_TOKEN` / `INPOST_ORGANIZATION_ID` — ShipX API
- `RESEND_API_KEY` — transactional email
- `NEXT_PUBLIC_GTM_ID` — Google Tag Manager (build-time)

## Key Conventions

**Monetary values:** Always integers in grosze. Use `pln()` from `src/lib/format.ts` for display.

**Server vs client components:** Default to server components (async). Add `'use client'` only when needed for state, hooks, or browser APIs. Secrets (Stripe, Supabase admin) are never exposed to the client — all sensitive operations go through API routes.

**Product IDs:** Single-letter category prefix + zero-padded number (`k01` = kubki 01). Category slugs: `kubki`, `wazony`, `wazony-duze`, `talerzyki`, `talerze-duze`, `duze-michy`, `miski-falowane`.

**CSS:** Token-driven via custom properties in `src/styles/tokens.css` (`--c-*` colors, `--f-*` fonts, `--gut` gutter, `--section-y` spacing, `--r-*` radii). No CSS-in-JS — plain CSS files colocated with components or in `src/styles/`.

**Responsive images:** Use `srcSet()` from `src/lib/images.ts` for product images. All product images are WebP in `public/uploads/`.

**API error responses:** `NextResponse.json({ error: reason }, { status: code })`. Checkout returns 400 (validation), 409 (pieces unavailable — include `unavailable: string[]`), 500 (server fault).

**Analytics:** Fire `begin_checkout` on cart → checkout navigation. Fire deduplicated `purchase` event on return page (keyed by `payment_intent` ID to prevent double-counting on refresh).

## Deployment

Cloudflare Workers via OpenNext (`open-next.config.ts`). Preview locally with `npm run preview:cf` (requires `wrangler` and `CLOUDFLARE_ACCOUNT_ID`). Workers Builds CI handles production deploys on push to main. The `wrangler.jsonc` configures the worker name, cron trigger, and static assets binding.

New migrations go in `supabase/migrations/` with timestamp prefix. Docs for deployment, E2E testing design, and analytics setup are in `docs/`.
