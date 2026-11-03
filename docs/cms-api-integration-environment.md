# CmsApi integration environment — provisioning runbook

Per the S1 brief §7, the CMS agent's integration testing needs an environment
isolated from production data: a separate Supabase project, separate R2
bucket, separate queues, provider test modes. `wrangler.jsonc`'s existing
`env.preview` block already isolates the *Worker* (name `ceramics-drop-preview`,
`routes: []` so it never inherits the production custom domain, its own
`FULFILMENT_QUEUE` + DLQ) — the remaining gap is that its Supabase/R2
bindings still point at production resources.

## One-time setup (operator, not an agent)

1. Create a new Supabase project (Supabase dashboard, or the `create_project`
   MCP tool if this session has one attached) dedicated to CMS integration
   testing. Record its URL and service-role key.
2. Apply every migration in `supabase/migrations/` to the new project, in
   order (`supabase db push` against the new project, or `supabase migration
   up` — see whichever the repo's existing deploy docs use for a fresh
   project).
3. Run `npm run catalog:backfill` against the new project's env so its
   `products`/`product_variants`/`product_media` mirror the code registry
   (matches how production was seeded).
4. Create a dedicated R2 bucket for print assets in this environment; do not
   reuse the production `PRINT_ASSETS` bucket.
5. Create a Cloudflare Access application for the CMS integration deployment
   (separate from the storefront's own `/admin` Access application), and
   record its audience tag and team domain.
6. Set these secrets against the `preview` Wrangler environment
   (`wrangler secret put <NAME> --env preview`):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` → the new project's values
     (override the preview env's inherited production values)
   - `CMS_ACCESS_TEAM_DOMAIN`, `CMS_ACCESS_AUD` → from step 5
   - `CMS_OWNERS` → the test owner account's email (brief §7: "konto testowe
     Access, właściciel"), plus a second account NOT in this list for the
     negative-test scenarios (brief §7: "konto poza listą — do testów
     negatywnych")
   - `CMS_PREVIEW_SECRET` → a freshly generated secret, independent of
     production's
   - `PRODIGI_API_KEY_SANDBOX`, `PRODIGI_ENV=sandbox` → provider test mode
     (never point this environment at live Prodigi)
   - `STRIPE_SECRET_KEY` → a Stripe **test-mode** key, never the live key
7. Update the `preview` environment's `PRINT_ASSETS` R2 binding in
   `wrangler.jsonc` to point at the bucket from step 4 (currently it likely
   still names the production bucket — confirm before running any print
   E2E test against this environment, since a wrong binding here would let
   preview traffic read/write production print assets).
8. Deploy: `npm run deploy:cf -- --env preview` (or the repo's existing
   preview deploy command — confirm exact invocation in
   `docs/cloudflare-deployment.md` before running).
9. Hand the CMS team: the deployed Worker name (for their `services` binding
   `entrypoint: "CmsApi"`), the test owner account credentials, and the
   negative-test account email.

## What this plan already did for you

- The `CmsApi` named entrypoint itself needs zero environment-specific code —
  same `worker.ts` export runs in every environment; only secrets differ.
- `contracts/cms-v1.json` + `contracts/fixtures/` (Task 1) are the version the
  CMS pins its generated client to, independent of which environment it's
  pointed at.
- `docs/cms-api-data-model.md` (Task 1) explains the revision/audit semantics
  the CMS UI needs to render correctly against real data from this
  environment.
