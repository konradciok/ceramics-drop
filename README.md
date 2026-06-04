# Anna Ciok Ceramics — storefront

Next.js storefront for Anna Ciok Ceramics, implementing the design in [`design/`](design/)
(the source of truth — left untouched).

## Stack

- **Next.js 16** (App Router) · **React 19** · **TypeScript**
- **next-intl** — trilingual routing: `/` (PL, default), `/en`, `/es`
- **Zustand** — cart store (set of one-of-a-kind product IDs), persisted to `localStorage`
- Ported brand CSS (design tokens + `site.css`) and self-hosted **Jost\*** fonts (geometric Futura alternative with full Polish glyph coverage)

## Scripts

```bash
npm run dev        # dev server
npm run build      # production build (static-prerenders all routes per locale)
npm run start      # serve the build (Node)
npm run lint       # eslint
npm run preview:cf # OpenNext + Wrangler preview (Workers runtime)
npm run deploy:cf  # build and deploy to Cloudflare Workers
```

**Production:** https://ceramics-drop.konrad-ciok.workers.dev — see [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md) for deploy, env vars, and Workers Builds CI.

## Layout

```
messages/            next-intl catalogs (pl/en/es) — trilingual content
public/fonts         Jost* variable webfonts (.woff2) + OFL license
public/icons         line-icon SVGs
public/uploads/      88 product images (WebP)
src/
  app/[locale]/      routes: home, 7 collections, koszyk (+ /return), o-studiu, kontakt, 3 legal pages
  app/api/           checkout · inventory · stripe/webhook
  components/         layout/ · shop/ · ui/
  i18n/              routing · request · navigation
  lib/               products · checkout · stripe · supabase · inventory · invoice · analytics · pricing · format
  store/cart.ts      Zustand cart
  styles/            fonts.css · tokens.css · site.css  (ported from design/)
  middleware.ts      next-intl locale middleware
```

## Status: live

Content-complete, payments-enabled, and deployed to Cloudflare Workers.

**Done:**

- **Content** — all pages built with real markup & copy; trilingual catalogs (PL/EN/ES) in
  `messages/`; 88 one-of-a-kind pieces from `getProducts()` in `src/lib/products.ts`; product
  images in `public/uploads/` (WebP, via `npm run optimize-images`).
- **Payments** — embedded Stripe Payment Element checkout in PLN. `/api/checkout` atomically
  reserves the selected pieces (15-min hold) before creating the PaymentIntent;
  `/api/stripe/webhook` does idempotent fulfillment, persists the order to Supabase, and
  invoices it; `/koszyk/return` shows the confirmation/processing/failure status.
- **Inventory** — one-of-a-kind sold-state tracking (`/api/inventory`, `src/lib/inventory.ts`)
  so a sold piece can't be re-purchased.
- **Analytics** — GA4 + Meta via GTM. `begin_checkout` on checkout start; a deduplicated
  `purchase` event fires once per `payment_intent` on the confirmed return
  (`src/lib/checkout-analytics.ts`). See [docs/analytics-stack.md](docs/analytics-stack.md).
- **Deploy** — Cloudflare Workers via OpenNext, with Workers Builds CI. See
  [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md).

**Design source of truth:** [`design/`](design/) is left untouched and remains the visual reference.
