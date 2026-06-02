# Cloudflare Workers deployment (OpenNext)

Anna Ciok Ceramics storefront runs on **Cloudflare Workers** with **Workers Static Assets**, built by [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare).

## Production URL

- **Custom domain:** https://anna-ciok.studio (and https://www.anna-ciok.studio)
- **workers.dev:** https://ceramics-drop.konrad-ciok.workers.dev
- **Account ID:** `3ebc59b80b15b6b4850ae0734a24ce26`
- **Worker name:** `ceramics-drop`
- **Zone ID:** `df154a46a71277a8b5b4a9e3d9af23ad` (`anna-ciok.studio`)

Custom domains are declared in `wrangler.jsonc` (`routes` with `custom_domain: true`). Registrar nameservers at Namecheap point to Cloudflare (`magnolia.ns.cloudflare.com`, `norman.ns.cloudflare.com`). Until the zone shows **Active** in the dashboard, the custom hostname may not resolve globally (typically 15–60 minutes after NS change).

## Stack (what is used)

| Service | Role |
| --- | --- |
| Cloudflare Workers | Next.js runtime (OpenNext worker at `.open-next/worker.js`) |
| Workers Static Assets | `public/`, `_next/static`, prerendered HTML cache |
| Wrangler | Local preview and deploy |

**Not provisioned (v1):** D1, KV, Durable Objects, Queues, Hyperdrive, R2, Cloudflare Images. The app is fully static SSG; incremental cache uses `staticAssetsIncrementalCache` (see `open-next.config.ts`).

## Prerequisites

1. **Cloudflare login:** `npx wrangler whoami`
2. **Product images:** `npm run optimize-images` (requires local `design/uploads/*.png`, gitignored). Commit `public/uploads/*.webp` for CI.
3. **Build-time env vars** (set locally and in Workers Builds):
   - `NEXT_PUBLIC_GTM_ID`
   - `NEXT_PUBLIC_GA4_MEASUREMENT_ID`
   - `NEXT_PUBLIC_META_PIXEL_ID`  
   Do **not** add GCP / GTM API secrets (`.secrets/`, `GTM_*`) to Cloudflare.

## Commands

```bash
npm run dev          # Next.js dev (day-to-day)
npm run build        # Next.js only
npm run preview:cf   # OpenNext build + Wrangler preview (Workers runtime, :8787)
npm run deploy:cf    # OpenNext build + deploy to Cloudflare
npm run cf-typegen   # Generate cloudflare-env.d.ts
```

### Local verification checklist

After `npm run preview:cf` (stop preview before `deploy:cf` on Windows — preview locks `.open-next/assets`):

- `/` — Polish (default locale, no prefix)
- `/en`, `/es` — prefixed locales
- `/uploads/kubek-1.webp` — product asset
- Page source includes GTM when `NEXT_PUBLIC_GTM_ID` was set at build time

## Observability (Workers Logs)

`wrangler.jsonc` enables **Workers Logs** (invocation + `console.log` output, 100% sampling, persisted). Traces stay off.

View logs: dashboard → **Workers & Pages** → **ceramics-drop** → **Logs**, or [Observability](https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability).

Redeploy after changing observability settings: `npm run deploy:cf` or `npx wrangler deploy`.

## Configuration files

| File | Purpose |
| --- | --- |
| `wrangler.jsonc` | Worker name, `nodejs_compat`, static assets binding, self-reference service, observability |
| `open-next.config.ts` | SSG static-assets incremental cache |
| `next.config.ts` | `initOpenNextCloudflareForDev()` for local dev |
| `public/_headers` | Long-cache headers for `/_next/static/*` |

## Workers Builds (CI/CD)

GitHub repo `konradciok/ceramics-drop` is connected to worker **ceramics-drop**. Production deploys run on push to `main`.

### Dashboard settings (current)

| Setting | Value |
| --- | --- |
| **Production branch** | `main` |
| **Root directory** | `/` |
| **Build command** | `npm ci` |
| **Deploy command** | `npm run deploy:cf` |
| **Node.js version** | 20 (if offered in build settings) |

`deploy:cf` runs `opennextjs-cloudflare build` (Next.js + OpenNext bundle) then `opennextjs-cloudflare deploy`. Do **not** use `npm run build` alone in CI — that only produces `.next/`, not `.open-next/`.

### Variables and secrets

Set under **Build** → **Variables and secrets** (production):

- `NEXT_PUBLIC_GTM_ID`
- `NEXT_PUBLIC_GA4_MEASUREMENT_ID`
- `NEXT_PUBLIC_META_PIXEL_ID`

Same values as `.env.local`. Do **not** add GCP / GTM API secrets.

### npm version (lockfile)

Workers Builds runs **npm 10.9.x** (bundled with Node 22). If you regenerate `package-lock.json` with **npm 11+**, `npm ci` can pass locally but fail in CI with:

```text
Missing: @swc/helpers@0.5.23 from lock file
```

Before pushing dependency changes, sync the lockfile with the same npm major as CI:

```bash
npx npm@10.9.2 install
npx npm@10.9.2 ci
```

### Assets

Ensure `public/uploads/*.webp` is committed so CI includes product images.

### First-time setup

1. [Cloudflare dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **ceramics-drop** → **Settings** → **Build**
2. Apply the commands and env vars above, then push to `main` or retry the latest build.

## Middleware

Locale routing uses `src/middleware.ts` (next-intl). This deployment uses OpenNext on Workers, **not** `output: 'export'`, so middleware runs at the edge.

## Windows note

OpenNext warns that Windows is not fully supported. Builds and deploy succeeded from this repo; prefer WSL for repeat deploys if you hit `EBUSY` on `.open-next` (stop `preview:cf` / `workerd` before redeploying).

## Related docs

- [Analytics stack](./analytics-stack.md) — GTM / GA4 / Meta (app-side only; GTM API scripts are dev-only)
