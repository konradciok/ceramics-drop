# Environment Variables

> Moved verbatim from `AGENTS.md` (context-diet restructure). `AGENTS.md` keeps a short stub with the invariants; this file holds the full detail. Perishable feature state lives in `docs/STATUS.md`.

### Environment Variables

**Build-time** (`NEXT_PUBLIC_*` — set as Workers Build env vars, NOT wrangler secrets):
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — Stripe Payment Element
- `NEXT_PUBLIC_GTM_ID` — Google Tag Manager
- `NEXT_PUBLIC_GA4_MEASUREMENT_ID` / `NEXT_PUBLIC_META_PIXEL_ID` — client analytics ids
- `NEXT_PUBLIC_SENTRY_DSN` — client-side error monitoring
- `NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN` / `NEXT_PUBLIC_INPOST_GEOWIDGET_ENV` — locker picker (Poland)
- `NEXT_PUBLIC_SENDCLOUD_PUBLIC_KEY` — Sendcloud hosted service point picker (Sendcloud countries); the integration's public key, browser-safe by design. Build-time (Workers Builds variable). Without it the picker shows the unavailable message and payment stays disabled for those countries

**Runtime secrets** (set with `wrangler secret put` in prod, `.dev.vars` locally):
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_PUBLISHABLE_KEY` — customer accounts (Supabase Auth), server-side only, never `NEXT_PUBLIC_*`; its presence (alongside the always-required `SUPABASE_URL`) is the feature flag / kill switch (see `docs/customer-accounts-runbook.md`)
- `INPOST_API_TOKEN` / `INPOST_ORGANIZATION_ID` / `INPOST_API_URL` / `INPOST_WEBHOOK_TOKEN`
- `SENDCLOUD_PUBLIC_KEY` / `SENDCLOUD_SECRET_KEY` (API v3 Basic auth), `SENDCLOUD_WEBHOOK_SIGNATURE_KEY` (its own key for the webhook HMAC, never the secret key), `SENDCLOUD_SENDER_ADDRESS_ID` (mainland-Spain sender address — a plain var in `wrangler.jsonc`), optional `SENDCLOUD_API_URL`. Without the keys an order on that channel fails closed (`SendcloudConfigError not_configured`, Sentry-alerted by the Stripe webhook) and checkout answers Sendcloud countries `503 delivery_point_check_failed`
- `CHECKOUT_COUNTRIES` — optional runtime var, comma-separated (e.g. `PL,ES,DE`): replaces the registry's `enabled` flags for which countries checkout offers. Lanes without a verified Sendcloud shipping option are dropped. Set by the hermetic E2E server; unset in production
- `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET` / `STUDIO_NOTIFY_EMAIL` / `SENTRY_DSN`
- `NEWSLETTER_CONFIRM_SECRET` — dedicated HMAC secret for newsletter double-opt-in confirm links (fail-closed: both `/api/newsletter*` routes 503 when unset; never reuse other secrets). Optional `RESEND_NEWSLETTER_AUDIENCE_ID` switches contact creation to the legacy Resend Audiences endpoint
- `META_CAPI_ACCESS_TOKEN` / `GA4_API_SECRET` (+ optional `META_TEST_EVENT_CODE`) — server-side conversions
- `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` / `ADMIN_ALLOWED_EMAILS` — Cloudflare Access gate for `/admin` (+ `STUDIO_ADMIN_LOCAL_BYPASS` to skip it in local dev)
- `CMS_PREVIEW_SECRET` — dedicated HMAC secret for admin draft-preview tokens (`/api/admin/content/preview` → `?preview=` on PDPs). Fail-closed: must be set or preview minting 500s; never reuse Stripe/Supabase secrets. The publish path is atomic via the `publish_cms_version()` RPC (migration `20260709120000`); notes are keyed by product id, not array position.

Retired with the print shop (2026-11) and no longer read by the code: `PRODIGI_*`, `PRINT_ASSET_TOKEN_SECRET`, `FULFILMENT_DEBUG_TOKEN` / `E2E_FULFILMENT_DEBUG_TOKEN`, `R2_S3_*`, `NEXT_PUBLIC_GOOGLE_PLACES_API_KEY` — delete any leftover wrangler secrets / build vars with those names.

See `.env.example` for the full list and setup notes. See `docs/cloudflare-deployment.md` for Workers Builds CI configuration and `docs/analytics-stack.md` for the analytics/conversion event contract.
