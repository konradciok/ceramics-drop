# Anna Ciok Ceramics — storefront

Next.js storefront for Anna Ciok Ceramics, implementing the design in [`design/`](design/)
(the source of truth — left untouched).

## Stack

- **Next.js 16** (App Router) · **React 19** · **TypeScript**
- **next-intl** — trilingual routing: `/` (PL, default), `/en`, `/es`
- **Zustand** — cart store (set of one-of-a-kind product IDs), persisted to `localStorage`
- Ported brand CSS (design tokens + `site.css`) and self-hosted **Futura BT** fonts

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
messages/            next-intl catalogs (pl/en/es) — empty, fill in content phase
public/fonts         Futura BT (.otf)
public/icons         line-icon SVGs
src/
  app/[locale]/      routes: home, 7 collections, koszyk, o-studiu, kontakt, 3 legal pages
  components/         layout/ · shop/ · ui/   (skeletons)
  i18n/              routing · request · navigation
  lib/               types · products (registry; data wiring deferred) · format
  store/cart.ts      Zustand cart
  styles/            fonts.css · tokens.css · site.css  (ported from design/)
  middleware.ts      next-intl locale middleware
```

## Status: scaffold

Structure + dependencies only. **Deferred to the content phase:**

- Page/component markup & copy (pages render placeholders; components are typed skeletons)
- i18n message catalogs (PL/EN/ES) — currently empty `{}`
- Product data: implement `getProducts()` in `src/lib/products.ts` (88 pieces, image paths,
  sold flags) — reference: `design/assets/shop.js`
- Product images → `public/uploads/` (from `design/uploads/`)
- Trilingual product descriptions
