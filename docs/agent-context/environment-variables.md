# Environment Variables

> Moved verbatim from `AGENTS.md` (context-diet restructure). `AGENTS.md` keeps a short stub with the invariants; this file holds the full detail. Perishable feature state lives in `docs/STATUS.md`.

### Environment Variables

**Build-time** (`NEXT_PUBLIC_*` — set as Workers Build env vars, NOT wrangler secrets):
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — Stripe Payment Element
- `NEXT_PUBLIC_GTM_ID` — Google Tag Manager
- `NEXT_PUBLIC_GA4_MEASUREMENT_ID` / `NEXT_PUBLIC_META_PIXEL_ID` — client analytics ids
- `NEXT_PUBLIC_SENTRY_DSN` — client-side error monitoring
- `NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN` / `NEXT_PUBLIC_INPOST_GEOWIDGET_ENV` — locker picker
- `NEXT_PUBLIC_GOOGLE_PLACES_API_KEY` — address autocomplete on the print checkout delivery form (`AddressAutocomplete.tsx`)

**Runtime secrets** (set with `wrangler secret put` in prod, `.dev.vars` locally):
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_PUBLISHABLE_KEY` — customer accounts (Supabase Auth), server-side only, never `NEXT_PUBLIC_*`; its presence (alongside the always-required `SUPABASE_URL`) is the feature flag / kill switch (see `docs/customer-accounts-runbook.md`)
- `INPOST_API_TOKEN` / `INPOST_ORGANIZATION_ID` / `INPOST_API_URL` / `INPOST_WEBHOOK_TOKEN`
- `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET` / `STUDIO_NOTIFY_EMAIL` / `SENTRY_DSN`
- `NEWSLETTER_CONFIRM_SECRET` — dedicated HMAC secret for newsletter double-opt-in confirm links (fail-closed: both `/api/newsletter*` routes 503 when unset; never reuse other secrets). Optional `RESEND_NEWSLETTER_AUDIENCE_ID` switches contact creation to the legacy Resend Audiences endpoint
- `META_CAPI_ACCESS_TOKEN` / `GA4_API_SECRET` (+ optional `META_TEST_EVENT_CODE`) — server-side conversions
- `PRODIGI_API_KEY_SANDBOX` / `PRODIGI_API_KEY_LIVE` / `PRODIGI_ENV` / `PRODIGI_CALLBACK_TOKEN` / `PRODIGI_DEFAULT_SHIPPING_METHOD` — print-on-demand fulfilment; `PRINT_ASSET_TOKEN_SECRET` signs the `/api/print-assets/[id]` URLs Prodigi pulls from
- `FULFILMENT_DEBUG_TOKEN` — fail-closed gate for the preview-only `/api/debug/fulfilment-status` read (destructive print-purchase E2E, audit H-2); never set in production. The E2E runner passes the same value via `E2E_FULFILMENT_DEBUG_TOKEN`
- `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` / `ADMIN_ALLOWED_EMAILS` — Cloudflare Access gate for `/admin` (+ `STUDIO_ADMIN_LOCAL_BYPASS` to skip it in local dev)
- `CMS_PREVIEW_SECRET` — dedicated HMAC secret for admin draft-preview tokens (`/api/admin/content/preview` → `?preview=` on PDPs). Fail-closed: must be set or preview minting 500s; never reuse Stripe/Supabase secrets. The publish path is atomic via the `publish_cms_version()` RPC (migration `20260709120000`); notes are keyed by product id, not array position.

See `.env.example` for the full list and setup notes. See `docs/cloudflare-deployment.md` for Workers Builds CI configuration and `docs/analytics-stack.md` for the analytics/conversion event contract.
