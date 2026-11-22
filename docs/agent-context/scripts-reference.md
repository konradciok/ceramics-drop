# Operational / one-off scripts

> Moved verbatim from `AGENTS.md` (context-diet restructure). `AGENTS.md` keeps a short stub with the invariants; this file holds the full detail. Perishable feature state lives in `docs/STATUS.md`.

### Operational / one-off scripts

Full list in `package.json`; deep usage lives in the linked docs — read those before running anything mutating. The print-era scripts (`prodigi`, `print-assets:*`, `collections:*`, `sync-prodigi-skus`, `print-fulfilment:check-jobs`, …) were removed with the print shop (2026-11).

| Command | Purpose | Reference |
|---|---|---|
| `npm run orders` | Order/inventory inspection CLI + the four admin mutations (refund, release-reservation, resend-confirmation, create-shipment) + `webhook-config-check` (live Stripe endpoint vs `HANDLED_STRIPE_EVENTS` drift guard) + `reconcile-refunds` (sweep fully-refunded charges the DB hasn't converged — dry-run by default; `--confirm <uuid>` converges one order, `--skip-relist` converges pieces to the private-sale terminal off-sale state). Mutations need `--confirm <order-id>`; non-prod blocked without `--allow-nonprod`; PII redacted by default | `docs/orders-cli.md` |
| `npm run private-sale:create` | Mint a single-use re-sale link for sold pieces | `docs/plans/private-sale-cart-link.md` |
| `npm run reconcile:orders` | Backfill missed emails / stuck InPost shipments (dry-run by default) | `docs/stripe-operations.md` |
| `npm run apple:client-secret` | Mint the Sign in with Apple ES256 client-secret JWT (6-month max validity) | `docs/customer-accounts-runbook.md` |
| `npm run i18n:pull` / `:push` / `:check` / `:organize` | Sync UI strings with Notion | `docs/notion-i18n.md` |
| `npm run gtm:setup` / `gtm:list` / `gtm:key` | Google Tag Manager API management | `docs/analytics-stack.md` |
| `npm run ga4:report` / `bq:query` | GA4 Data API + BigQuery export reports | `docs/analytics-stack.md` |
| `npm run notes:generate` | Draft product notes | — |
| `npm run generate-image-variants` | Variant-only image optimise | — |
| `npm run cf-typegen` | Regenerate Cloudflare env types | — |
| `npm run cf:dns-cleanup` | Cloudflare DNS maintenance (stale Namecheap MX/TXT) | `docs/cloudflare-deployment.md` |
| `npm run admin:dev:lan` + `admin:proxy` | `/admin` UI over LAN via nginx reverse proxy | see [admin-cms-api.md](admin-cms-api.md) |
