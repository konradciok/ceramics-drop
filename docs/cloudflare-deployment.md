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

> **Deploy gate — apply pending Supabase migrations BEFORE promoting a Workers build.**
> `reserve_pieces()` only `UPDATE`s existing `piece_state` rows, so a catalogue id with no row is never actually reserved at checkout (silent double-sale risk). Whenever a release adds/renames product ids (e.g. `supabase/migrations/20260609120000_inventory_review_june.sql` added `k01`), apply the migration to Supabase prod first, then deploy.
>
> Before merging PR #51, apply `supabase/migrations/20260609130000_orders_marketing.sql` to Supabase prod. The checkout route now inserts `orders.marketing`; without this column the insert fails at runtime.
>
> Audit for gaps — paste the catalogue ids (`getProducts().map(p => p.id)` from `src/lib/products.ts`) into the array literal; any rows returned are ids missing a `piece_state` row:
>
> ```sql
> select unnest(array['k01','k02','…']) as id
> except
> select product_id from piece_state;
> ```

## Prerequisites

1. **Cloudflare login:** `npx wrangler whoami`
2. **Product images:** `npm run optimize-images` (requires local `design/uploads/*.png`, gitignored). Commit `public/uploads/*.webp` for CI.
3. **Build-time env vars** (set locally and in Workers Builds):
   - `NEXT_PUBLIC_GTM_ID`
   - `NEXT_PUBLIC_GA4_MEASUREMENT_ID`
   - `NEXT_PUBLIC_META_PIXEL_ID`
   - `NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN` — required by `GeowidgetPicker`; any non-empty value satisfies the e2e mock seam (real token needed for production locker selection)
   Do **not** add GCP / GTM API secrets (`.secrets/`, `GTM_*`) to Cloudflare.

## Commands

```bash
npm run dev          # Next.js dev (day-to-day)
npm run build        # Next.js only
npm run preview:cf   # OpenNext build + Wrangler preview (Workers runtime, :8787)
npm run deploy:cf    # OpenNext build + deploy to Cloudflare
npm run cf-typegen   # Regenerate cloudflare-env.d.ts (uses `.env.cf-typegen`, not `.env.local`)
npm run cf:dns-cleanup   # Remove stale Namecheap MX/TXT (needs CLOUDFLARE_API_TOKEN)
npm run cf:com-redirect  # 301 anna-ciok.com → anna-ciok.studio (needs zone + token — see below)
```

### DNS cleanup (optional)

After nameserver cutover, remove legacy registrar forwarding records:

```bash
set CLOUDFLARE_API_TOKEN=...
npm run cf:dns-cleanup
```

Requires **Zone.DNS Edit** for `anna-ciok.studio`. Does not add apex/www records — fix those in the dashboard if the apex hostname fails to resolve.

### Canonical host (dashboard)

Use **one** public hostname for SEO and analytics. Recommended: redirect `www.anna-ciok.studio` → `anna-ciok.studio` (or the reverse) via a **Redirect rule** in the zone. Ensure the apex has proxied **A and AAAA** records, not IPv6-only.

### Secondary domain redirect (`anna-ciok.com` → `anna-ciok.studio`)

The storefront canonical origin stays **`anna-ciok.studio`** (`src/lib/site.ts`). `anna-ciok.com` is a **301 alias only** — do **not** add it as a Worker custom domain in `wrangler.jsonc` (that would serve duplicate content on two hostnames).

| Item | Value |
| --- | --- |
| Registrar | Namecheap |
| Nameservers | `magnolia.ns.cloudflare.com`, `norman.ns.cloudflare.com` (already set) |
| Zone | Separate Cloudflare zone for `anna-ciok.com` (not the `.studio` zone) |
| Mechanism | Proxied placeholder DNS + Single Redirect rules (301, preserve path + query) |

**Prerequisites**

1. **Zone onboarded** — [Domains](https://dash.cloudflare.com/?to=/:account/domains) → Add a domain → `anna-ciok.com` → Free plan. Because nameservers already point to Cloudflare, activation is usually immediate (no registrar NS change).
2. **API token** with **Zone Edit**, **DNS Edit**, and **Single Redirect Edit** for `anna-ciok.com`. The Workers-scoped token in `.env.local` (`#zone:read` only) is insufficient.

**Automated setup**

```bash
CLOUDFLARE_API_TOKEN=... npm run cf:com-redirect
```

Script: [`scripts/cloudflare-com-redirect-setup.mjs`](../scripts/cloudflare-com-redirect-setup.mjs). Idempotent — creates proxied `A` records (`@` and `www` → `192.0.2.0`) and two redirect rules:

| Rule | Match | Target |
| --- | --- | --- |
| `com-to-studio-apex` | `http.host eq "anna-ciok.com"` | `https://anna-ciok.studio` + path |
| `com-to-studio-www` | `http.host eq "www.anna-ciok.com"` | `https://anna-ciok.studio` + path |

**Verify**

```bash
curl -sI https://anna-ciok.com/kubki/k01 | grep -iE '^(HTTP|location):'
curl -sI https://www.anna-ciok.com/en | grep -iE '^(HTTP|location):'
```

Expect `301` and `Location: https://anna-ciok.studio/...`.

**Post-launch (ops)**

- **Google Search Console** — add `anna-ciok.com` as a Domain property; confirm Google sees the 301 to `.studio`. Keep `.studio` as the primary indexed property (`https://anna-ciok.studio/sitemap.xml`).
- **No app changes** — Stripe webhooks, InPost, Resend, analytics all stay on `.studio`.

**Rollback** — pause/delete the two redirect rules in the `.com` zone; remove placeholder A records. The `.studio` Worker is unaffected.

### WAF rate limiting (dashboard / API)

Applied **2026-06-08** on zone `df154a46a71277a8b5b4a9e3d9af23ad`:

| Rule | Expression | Limit | Action |
| --- | --- | --- | --- |
| `checkout-rate-limit` | `POST` `/api/checkout` | 5 req / 10 s / IP (~30/min) | block |

Ruleset `237f07c4303b4afbaa7854baeea64c01` · rule `020447cad9604aeb9361fde0155d0689`.

**Free plan constraints:** `http_ratelimit` rules use a 10 s sampling period, 10 s mitigation timeout, `block` only (no managed challenge), and **one rule per zone**. `/api/returns` is covered by the in-app limiter (`src/app/api/returns/route.ts`); add a second WAF rule after upgrading to Pro if needed.

Verify: Security → WAF → Rate limiting rules, or `GET /zones/{zone_id}/rulesets/phases/http_ratelimit/entrypoint`.

### Local verification checklist

After `npm run preview:cf` (stop preview before `deploy:cf` on Windows — preview locks `.open-next/assets`):

- `/` — Polish (default locale, no prefix)
- `/en`, `/es` — prefixed locales
- `/uploads/kubek-1.webp` — product asset
- Page source includes GTM when `NEXT_PUBLIC_GTM_ID` was set at build time

## Observability (Workers Logs)

`wrangler.jsonc` enables **Workers Logs** (invocation + `console.log` output, **25% head sampling**, persisted). Traces stay off. Raise `head_sampling_rate` temporarily when debugging a production issue.

View logs: dashboard → **Workers & Pages** → **ceramics-drop** → **Logs**, or [Observability](https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability).

Redeploy after changing observability settings: `npm run deploy:cf` or `npx wrangler deploy`.

## Configuration files

| File | Purpose |
| --- | --- |
| `wrangler.jsonc` | Worker name, `nodejs_compat`, static assets binding, self-reference service, observability |
| `open-next.config.ts` | SSG static-assets incremental cache |
| `next.config.ts` | `initOpenNextCloudflareForDev()` for local dev |
| `public/_headers` | Long-cache for static assets; security headers; `noindex` on `workers.dev` |
| `src/app/robots.ts` · `src/app/sitemap.ts` | SEO (`metadataBase` → `https://anna-ciok.studio`) |
| `src/lib/site.ts` | Canonical origin + route list for sitemap |

## Workers Builds (CI/CD)

GitHub repo `konradciok/ceramics-drop` is connected to worker **ceramics-drop**. Production deploys run on push to `main`.

### Dashboard settings (current)

| Setting | Value |
| --- | --- |
| **Production branch** | `main` |
| **Root directory** | `/` |
| **Build command** | `npm ci` |
| **Deploy command** | `npm run deploy:cf` |
| **Node.js version** | 22 (Workers Builds default; keep `package-lock.json` on npm 10.9.x) |

`deploy:cf` runs `opennextjs-cloudflare build` (Next.js + OpenNext bundle) then `opennextjs-cloudflare deploy`. Do **not** use `npm run build` alone in CI — that only produces `.next/`, not `.open-next/`.

### Variables and secrets

Set under **Build** → **Variables and secrets** (production):

- `NEXT_PUBLIC_GTM_ID`
- `NEXT_PUBLIC_GA4_MEASUREMENT_ID`
- `NEXT_PUBLIC_META_PIXEL_ID`
- `NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN` — InPost Geowidget token; required at build time so `GeowidgetPicker` renders the widget instead of the unavailable fallback. Also required for the `@ci` e2e specs (`checkout-409`, `geowidget-unavailable`) to pass against preview builds.

Same values as `.env.local`. Do **not** add GCP / GTM API secrets.

### Runtime secrets (`wrangler secret put`)

The build vars above are **not** the runtime secrets. Server-only secrets are set per-environment with `wrangler secret put <NAME>` (or `.dev.vars` locally) — see `.env.example` for the authoritative list and inline notes. Beyond Stripe/Supabase/InPost, the **returns + studio-email** flow needs:

- `RESEND_API_KEY`, `STUDIO_NOTIFY_EMAIL` — transactional mail (return labels, shipping confirmations); Resend template aliases are wired in `src/lib/email-layout.ts`.
- `RESEND_WEBHOOK_SECRET` — Svix signing secret for `/api/resend/webhook`; get from the Resend dashboard → Webhooks → signing secret. **Required after deploying PR #44** or the endpoint returns `500`.
- `STUDIO_RETURN_FIRST_NAME` / `_LAST_NAME` / `_PHONE` / `_ADDRESS_STREET` / `_BUILDING` / `_CITY` / `_POSTAL` / `_POINT` — the InPost return receiver. **All required**, or `POST /api/returns` returns `503`. `STUDIO_RETURN_EMAIL` defaults to `STUDIO_NOTIFY_EMAIL` when unset.
- `META_CAPI_ACCESS_TOKEN` — Meta system-user token for Conversions API (`wrangler secret put META_CAPI_ACCESS_TOKEN`)
- `GA4_API_SECRET` — GA4 Admin → Data Streams → Measurement Protocol API secrets (`wrangler secret put GA4_API_SECRET`)
- `META_TEST_EVENT_CODE` — (optional, validation only) Meta Events Manager test event code; remove before go-live

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

OpenNext warns that Windows is not fully supported. For local deploy on Windows:

1. Enable **Developer Mode** (Settings → For developers) so OpenNext can create symlinks during the bundle step.
2. Stop `preview:cf` / `workerd` before deploy if you hit `EBUSY` or `EPERM` deleting `.open-next`.
3. Use `npx wrangler` (not bare `wrangler`) unless Wrangler is installed globally.
4. `wrangler.jsonc` uses `npx opennextjs-cloudflare build` (not `node_modules/.bin/...`) so Wrangler’s custom build works in cmd/PowerShell.

Prefer WSL if symlink or file-lock errors persist.

## Related docs

- [Analytics stack](./analytics-stack.md) — GTM / GA4 / Meta (app-side only; GTM API scripts are dev-only)
