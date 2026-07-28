# Anna Ciok Ceramics — storefront

E-commerce storefront for one-of-a-kind ceramics and fine-art prints by Anna Ciok.
Live at **[anna-ciok.studio](https://anna-ciok.studio)**.

> **Working with AI agents or contributing?** Start at **[AGENTS.md](AGENTS.md)** — the
> canonical project context (architecture, commands, conventions). Volatile feature
> state is in [docs/STATUS.md](docs/STATUS.md); the docs index is
> [docs/README.md](docs/README.md).

## Stack

- **Next.js 16** (App Router, webpack builds only — see AGENTS.md § Build system) · **React 19** · **TypeScript**
- **Cloudflare Workers** via OpenNext (Workers Builds deploys on every push to `main`), with a cron + Cloudflare Queue in `worker.ts`
- **Supabase** — inventory/reservation state, orders, catalog shadow tables (`CATALOG_SOURCE=db` in prod), customer accounts (server-only Auth)
- **Stripe** — embedded Payment Element checkout in PLN/EUR/GBP (BLIK, P24, Bizum, cards); webhook-driven fulfilment
- **InPost ShipX** (ceramics shipping) · **Prodigi** (print-on-demand fine-art prints, queued fulfilment)
- **next-intl** — four locales: `/` (PL, default), `/en`, `/es`, `/de`; display currency from a `currency_pref` cookie, not the locale
- **Zustand** cart (tokens, no quantities), GA4 + Meta via GTM behind Consent Mode v2

## Commands

```bash
npm run dev        # dev server (webpack)
npm run build      # production build (next build --webpack — non-negotiable)
npm run lint       # eslint
npm run typecheck  # tsc (app + worker)
npm run test       # vitest unit tests
npm run test:e2e   # Playwright @ci specs (hermetic localhost)
npm run preview:cf # OpenNext + Wrangler preview (Workers runtime)
npm run deploy:cf  # build and deploy to Cloudflare Workers
```

The full operational-script catalogue (orders CLI, Prodigi CLI, print-asset
pipeline, i18n sync, analytics tooling) is in AGENTS.md § Operational scripts.

## Layout

```
messages/            next-intl catalogs (pl/en/es/de)
public/uploads/      product images (WebP + variants)
supabase/            migrations + pgTAP tests
e2e/                 Playwright specs (@ci / @checkout-edge / @destructive)
scripts/             operational CLIs (orders, prodigi, print-assets, i18n, gtm…)
src/
  app/[locale]/      storefront routes (collections, PDPs, koszyk, konto, …)
  app/admin/         studio back-office (Cloudflare Access-gated in prod)
  app/api/           checkout · inventory · webhooks (stripe/inpost/resend/prodigi) · auth · feeds
  components/        layout/ · shop/ · ui/
  lib/               domain logic (products, prints, pricing, checkout, marketing, admin)
  server/            third-party fulfilment (Prodigi client + queue pipeline)
  store/cart.ts      Zustand cart
  styles/            design tokens + site CSS
worker.ts            OpenNext wrapper + cron + queue consumer + Access gate
```

## Status

Live: content-complete, payments-enabled, prints + customer accounts shipped.
See [docs/STATUS.md](docs/STATUS.md) for the current feature-state snapshot and
[CHANGELOG.md](CHANGELOG.md) for releases (managed by release-please).

**Design source of truth:** the local `design/` folder (gitignored) remains the
visual reference; product images are generated from it via `npm run optimize-images`.
