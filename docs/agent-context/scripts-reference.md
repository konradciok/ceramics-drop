# Operational / one-off scripts

> Moved verbatim from `AGENTS.md` (context-diet restructure). `AGENTS.md` keeps a short stub with the invariants; this file holds the full detail. Perishable feature state lives in `docs/STATUS.md`.

### Operational / one-off scripts

Full list in `package.json`; deep usage lives in the linked docs — read those before running anything mutating.

| Command | Purpose | Reference |
|---|---|---|
| `npm run orders` | Order/inventory inspection CLI + the four admin mutations (refund, release-reservation, resend-confirmation, create-shipment) + `webhook-config-check` (live Stripe endpoint vs `HANDLED_STRIPE_EVENTS` drift guard) + `reconcile-refunds` (sweep fully-refunded charges the DB hasn't converged — dry-run by default; `--confirm <uuid>` converges one order, `--skip-relist` converges pieces to the private-sale terminal off-sale state). Mutations need `--confirm <order-id>`; non-prod blocked without `--allow-nonprod`; PII redacted by default | `docs/orders-cli.md` |
| `npm run prodigi` | Prodigi API v4 CLI — sandbox quotes/orders, SKU lookup, order inspection. Sandbox unless `--live`; paid production orders always go through the queue | `docs/prodigi-cli.md` |
| `npm run prodigi:contract-smoke` | Manual sandbox create→inspect→cancel contract smoke (real mapper+client round-trip); also a `workflow_dispatch` CI job | `docs/prodigi-contract-smoke.md` |
| `npm run print-assets:onboard` | Batch-onboard new print designs from a manifest (`config/print-assets/onboarding-manifest.json` + `design/print-assets/_incoming/`); validates master resolution per variant, writes per-design configs, emits ready-to-paste `PrintDesign` entries — never edits `prints.ts` or the DB. `--dry-run`/`--force`/`--manifest <path>` | `docs/print-asset-runbook.md` § Batch onboarding |
| `npm run print-assets:prepare` / `:upload` / `:verify` / `:publish` | Print-fulfilment asset pipeline (compose print-area derivatives → R2 upload → byte-identity verify → atomic publish). All take `--product`/`--revision` and support `--dry-run`; publish requires `--confirm <revision>` | `docs/plans/print-asset-pipeline.md`, `docs/print-asset-runbook.md` |
| `npm run print-assets:gallery` | Storefront gallery WebPs from a published fulfilment derivative (R2 + `public/uploads/` mirror) | `docs/print-asset-runbook.md` |
| `npm run print-assets:mockups` | Pre-rendered configurator hero mockups from published derivatives + shared frame masters (`config/print-assets/frames.json`); `--product` required, optional `--state`/`--revision`/`--dry-run`; ships with the design's `mockups: true` flag | `docs/print-asset-runbook.md` |
| `npm run print-assets:editorial` | Storefront editorial/lifestyle gallery WebPs (3 slides/design) from `design/uploads/master-images-prints/print-{NNN}/`, mirrored to `public/uploads/` only (no R2); `--product <id>` or `--all` (validates every design's source folder first, incl. drafts), optional `--dry-run`; a successful non-dry-run `--all` also writes paste-ready `editorialGallery` registry snippets | `docs/print-asset-runbook.md` |
| `npm run print-assets:facets` | Suggest colour families for the `/sklep` colour filter from each design's 400 px WebP (paper discounted, `src/lib/print-colour.ts`) and write `config/print-shop.json`; `--dry-run` prints the table, reviewed entries (`reviewed: true`) are never overwritten without `--force`. Run after onboarding designs — a CI test fails while a published design has no colour | `docs/print-asset-runbook.md` § Shop colour filters |
| `npm run collections:import-descriptions` | Import the owner-approved print-collection descriptions (PL/EN/ES/DE; default file `docs/copy/2026-09-30-opisy-kolekcji/opisy-kolekcji.json`, follow-up packages via `--file`) into the CMS through the same `save_collection_draft` → `publish_collection_revision` RPCs the CMS uses (audit-logged as `import-descriptions@…`). **Dry-run by default** (prints the plan); `--confirm` writes; `--only <slug,…>` for a canary; `--force` also overwrites descriptions edited in the CMS (otherwise only blank/"<name>." placeholders are replaced, and the plan quotes each text it keeps); a collection with someone else's unpublished draft is skipped; refuses unless the file's `status` is `approved`. Needs production `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — publishes are permanent | `docs/copy/2026-09-30-opisy-kolekcji/README.md` § 5 |
| `npm run print-assets:sandbox-matrix` | One Prodigi sandbox order per print-area profile, using production signed asset URLs | `docs/print-asset-runbook.md` |
| `npm run print-asset:smoke` | HEAD probe of a signed print-asset URL against a live origin (redacts `sig`) | `docs/print-asset-runbook.md` |
| `npm run print-fulfilment:check-jobs` / `print-assets:inventory` | Pre-cutover gates for the print pipeline | `docs/print-asset-runbook.md` |
| `npm run sync-prodigi-skus` | Verify/upsert Prodigi print SKUs into `pod_variants` | `docs/prodigi-cli.md` |
| `npm run private-sale:create` | Mint a single-use re-sale link for sold pieces | `docs/plans/private-sale-cart-link.md` |
| `npm run reconcile:orders` | Backfill missed emails / stuck InPost shipments (dry-run by default) | `docs/stripe-operations.md` |
| `npm run apple:client-secret` | Mint the Sign in with Apple ES256 client-secret JWT (6-month max validity) | `docs/customer-accounts-runbook.md` |
| `npm run i18n:pull` / `:push` / `:check` / `:organize` | Sync UI strings with Notion | `docs/notion-i18n.md` |
| `npm run gtm:setup` / `gtm:list` / `gtm:key` | Google Tag Manager API management | `docs/analytics-stack.md` |
| `npm run gmc:fetch` | Merchant Center: trigger an immediate fetch of the scheduled feed sources after a shipping-rate/price publish (dry-run by default; `--confirm` to run; needs a service account key via `--key-file`/`GMC_KEY_FILE`) | `docs/shipping-rates-runbook.md` |
| `npm run ga4:report` / `bq:query` | GA4 Data API + BigQuery export reports | `docs/analytics-stack.md` |
| `npm run notes:generate` | Draft product notes | — |
| `npm run generate-image-variants` | Variant-only image optimise | — |
| `npm run cf-typegen` | Regenerate Cloudflare env types | — |
| `npm run cf:dns-cleanup` / `cf:com-redirect` | Cloudflare DNS + `.com→.studio` redirect maintenance | `docs/cloudflare-deployment.md` |
| `npm run admin:dev:lan` + `admin:proxy` | `/admin` UI over LAN via nginx reverse proxy | see Admin below |
