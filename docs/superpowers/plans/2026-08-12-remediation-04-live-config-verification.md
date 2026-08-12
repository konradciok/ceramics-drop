# Remediation 04 — Live-config verification sweep (H-4 / M-6 / M-25 / L-25 / H-2 / §15) — P0-adjacent, read-only

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §15 (Verification Gaps) + findings H-4, M-6, M-25, L-25, H-2, L-40. This plan is **almost entirely read-only**; each check has explicit branch outcomes that select an implementation variant elsewhere. Do not invent verification results.

**Goal:** Settle every audit item that could not be confirmed read-only from the repo, so downstream plans implement against facts instead of inferences.

**Architecture:** A checklist of dashboard/CLI reads with recorded outputs, each mapping to a decision. Results are recorded in a dated verification log (`docs/audits/backend-audit-2026-08-12-verification.md`) so the audit's `[UNVERIFIED]` items get closed out with evidence.

**Tech stack:** Stripe Dashboard/API (read), Sentry UI, Cloudflare dashboard + `wrangler` (read), Supabase dashboard (read), `curl` against a **preview** deployment only.

## Objective

Convert the audit's `[UNVERIFIED]`/`[INFERENCE]` items into confirmed facts with recorded evidence, and route each outcome to the plan that acts on it.

## Findings covered

- **H-4** (MEDIUM) — live Sentry "supabaseUrl is required." on the admin content editor. → REQUIRES-VERIFICATION (this plan decides the fix variant)
- **M-6** (LOW as designed) — admin email allowlist fail-open; severity depends on the Cloudflare Access app policy. → REQUIRES-VERIFICATION (severity gate for Plan 09)
- **M-25** (MEDIUM `[UNVERIFIED]`) — Supabase key format (legacy JWT vs `sb_secret_`/`sb_publishable_`). → REQUIRES-VERIFICATION
- **L-25** (LOW `[UNVERIFIED]`) — R2 bucket public-access posture. → REQUIRES-VERIFICATION
- **H-2** (LOW `[REFUTED]`) — admin-gate percent-encoding variants; empirical confirmation outstanding. → REQUIRES-VERIFICATION (code hardening itself is Plan 09)
- **L-40** (LOW) — ceramic EUR/GBP checkout price from per-category constants vs DB columns; display-vs-charge parity unverified. → REQUIRES-VERIFICATION
- **§15.1** (Stripe v2 Event Destinations) — executed as Plan 01 Task 5 pre-check; recorded here for completeness.
- **§15.9** — prod secret-name presence sweep. → REQUIRES-VERIFICATION

## Current-state evidence

- `VERIFIED` `src/lib/admin/access.ts:78-85` — allowlist block skipped entirely when `ADMIN_ALLOWED_EMAILS` unset → `{ ok: true }` for any valid-AUD CF Access JWT. The config check above it (:60-62) fails closed 404 without `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`.
- `VERIFIED` `src/lib/admin/access.ts:3,37-39` — `ADMIN_PATH_RE` tests the raw pathname, no decode/normalize; called from `worker.ts:34` with `new URL(request.url).pathname`.
- `VERIFIED` `src/app/admin/content/[kind]/[slug]/page.tsx:16` region + `src/lib/supabase.ts:9-13` — `createClient(env.SUPABASE_URL, …)` throws "supabaseUrl is required." when the URL is undefined (H-4's error string).
- `VERIFIED` (repo side of L-40) — checkout derives ceramic EUR/GBP from per-category constants in `src/lib/pricing.ts`, while the catalog shadow `products` table carries per-product `price_eur`/`price_gbp` columns that nothing reads (`catalog_shadow.sql:31-35`; audit §6.5).
- `CONFIRMED-LIVE` (audit) — Sentry shows 6 "supabaseUrl is required." events over ~20 h clustered after the 0.14.0 build window, 0 users affected.
- Everything else in this plan is by definition `NEEDS-RUNTIME-VERIFICATION`.

## Desired end state

A committed verification log with, for each item: the exact check performed, the raw (redacted where secret) output, the resolved branch, and the downstream plan/step it feeds. No live system mutated.

## Scope

- New file: `docs/audits/backend-audit-2026-08-12-verification.md` (the only repo change)
- Read-only operations against Stripe, Sentry, Cloudflare, Supabase dashboards/CLIs
- `curl` requests against a **preview** worker only (H-2)

## Out of scope

- Any fix implementation (each branch outcome routes to Plans 01/05/09 or a new mini-plan).
- Any mutation of live systems, including "harmless" config toggles.
- Key rotation (if M-25 confirms legacy keys, rotation becomes its own gated task — see Risks).

## Implementation steps

Each step records: command/screen, output, chosen branch.

### Task 1 — H-4: root-cause the admin-editor Sentry error

- [ ] In Sentry, open the "supabaseUrl is required." issue; read the newest event's **request host/URL** and `release`/environment tags.
- [ ] Branch on the host — but **"no request context" is not, by itself, benign**: a Sentry event without a request host can still originate from a production isolate. Require *corroborating* evidence before closing H-4 as benign, not the absence of a host alone.
  - **Preview/build host** (an explicit non-prod host on the event) → benign build/route-collection noise. Outcome: mark H-4 resolved-as-benign in the log; optionally file a one-line backlog item to fail-soft the admin editor like `/konto` (no P1 work).
  - **`anna-ciok.studio`** → the prod `SUPABASE_URL` binding regressed for that deployment. Outcome: escalate immediately — check `wrangler secret list` / Workers Builds env for the missing binding; fixing it is a **gated live mutation** (operator approval) executed outside this plan.
  - **No request context / ambiguous** → do **not** default to benign. Only mark benign when the `release`/environment tag is a preview/build release **and** the event timing clusters with a build window **and** the error has stopped recurring; if any of those is missing or the release maps to a production deploy, record H-4 as **unresolved** and escalate to the `anna-ciok.studio` branch's checks. Otherwise leave it open for a follow-up with the operator.
- [ ] Cross-check (feeds the branch above): is the error still occurring (any event in the last 7 days)? Read the `release`, environment, and deployment host, and the first/last-seen timestamps. A stopped error + build-window clustering + a preview/build release together support benign; a production release, ongoing events, or missing corroboration do not.

### Task 2 — M-6: Cloudflare Access policy + allowlist presence

- [ ] In the Cloudflare Zero Trust dashboard, open the Access application covering `anna-ciok.studio/admin*`; record its policy (who is allowed: specific emails? email domain? everyone with the org IdP?).
- [ ] `wrangler secret list` — is `ADMIN_ALLOWED_EMAILS` set in prod? (Names only; do not read values.)
- [ ] Branch:
  - **Policy is narrow (named emails) AND allowlist set** → M-6 stays LOW; Plan 09 implements fail-closed as scheduled hardening.
  - **Policy is broad OR allowlist unset** → M-6 escalates to MEDIUM+; Plan 09's fail-closed change becomes a priority item and the operator should be told immediately (before Plan 09 lands, tightening the Access policy itself is the faster mitigation — dashboard change, gated).

### Task 3 — M-25: Supabase key format

- [ ] In the Supabase dashboard (project `wnlysejenowymjdxlnaq`) → Settings → API keys: record whether the service key in use is legacy JWT (`eyJ…`) or new-format `sb_secret_…`, and whether `SUPABASE_PUBLISHABLE_KEY` (customer accounts) is `sb_publishable_…`.
- [ ] Branch:
  - **New-format keys** → M-25 closed, no action.
  - **Legacy JWT keys** → rotation required before the end-2026 deprecation. Outcome: create a dedicated rotation runbook task (key rotation touches `wrangler secret put`, `.dev.vars`, CI — all gated live mutations); do NOT rotate within this plan.

### Task 4 — L-25: R2 bucket posture

- [ ] Collect **separate** read-only evidence for each exposure control — `wrangler r2 bucket info` alone does **not** prove `r2.dev` or custom-domain state:
  - `wrangler r2 bucket dev-url get anna-ciok-print-assets` → confirm the managed `r2.dev` dev URL is **disabled**.
  - `wrangler r2 bucket domain list anna-ciok-print-assets` → confirm **no** custom public domain is attached.
  - `wrangler r2 bucket info anna-ciok-print-assets` → general posture (recorded, but not sufficient on its own).
  - Separately (Cloudflare dashboard / API): confirm the operator S3 API token is scoped to **this bucket only**.
- [ ] Branch: any public access (enabled dev URL, attached custom domain) → escalate (the signed-URL model is bypassed; disabling it is a gated mutation, urgent). All three checks clean **and** token scoped → closed with the three command outputs recorded.

### Task 5 — H-2: empirical admin-gate variant probes (preview only)

- [ ] Against a **preview** deployment (never prod): `curl -is https://<preview-host>/api/%61dmin/refund` and `curl -is https://<preview-host>/api/admin%2frefund` (and `//api/admin/refund`).
- [ ] Expected per the audit's refutation: `404` (handler never reached). Branch:
  - **404s** → refutation empirically confirmed; Plan 09's normalize-in-`isAdminPath` remains defense-in-depth (LOW).
  - **405/JSON error (handler reached)** → the refutation was wrong; H-2 re-opens as HIGH — stop, report, and pull the `isAdminPath` normalization forward as an emergency fix ahead of Plan 09.

### Task 6 — §15.9: prod secret-name sweep

- [ ] `wrangler secret list` (one run, shared with Tasks 2/Plan 03): record the full name list. Cross-check against the required set in `cloudflare-env.d.ts` (non-optional keys): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CMS_PREVIEW_SECRET`, `NEWSLETTER_CONFIRM_SECRET`, `RESEND_API_KEY`, `STUDIO_NOTIFY_EMAIL`, `SENTRY_DSN`, `PRODIGI_*`, `PRINT_ASSET_TOKEN_SECRET`, `CF_ACCESS_*`, `INPOST_*`.
- [ ] Confirm `FULFILMENT_DEBUG_TOKEN` is **absent** in prod (it must never be set there — L-39/AGENTS.md).
- [ ] Branch: any required name missing → report to operator (setting it is gated); all present → recorded, closed.

### Task 7 — L-40: display-vs-charge price parity (read-only data check)

- [ ] Read-only SQL against prod (or the Supabase dashboard SQL editor): `select id, category_slug, price_pln, price_eur, price_gbp from products where type='ceramic'` — compare against `PRICE_EUR`/`PRICE_GBP` per-category constants in `src/lib/pricing.ts`.
- [ ] **Note the current-state evidence:** no code path reads `products.price_eur`/`products.price_gbp` — checkout and display both use the per-category constants in `src/lib/pricing.ts`. So a divergence in these columns is **data drift in unused columns, not a customer-visible display-vs-charge mismatch** on its own.
- [ ] Branch:
  - **Columns NULL/unused, or equal to the constants** → parity holds; L-40 stays a backlog item (§6.5: wire or remove the columns).
  - **Columns diverge from the constants** → record as **data drift** and keep L-40 a backlog item. Do **not** escalate to a customer-facing pricing incident on this evidence alone. Escalate to a data-integrity finding **only after** confirming a live customer-facing or charging surface actually reads those columns and produces a value different from the charged per-category constant.

### Task 8 — write the log

- [ ] Create `docs/audits/backend-audit-2026-08-12-verification.md` with a table: item / check / output (redacted) / date / resolved branch / downstream action. Commit it.

## Database / migration work

None. All SQL is read-only SELECT.

## External-system changes

None mutating. Every check above is read-only; every branch that *would* mutate (secret set, Access policy change, key rotation, R2 access toggle) is explicitly deferred to a gated follow-up with operator approval.

## Tests

None (no code changes). The deliverable is the evidence log.

## Verification

The plan **is** verification. Completion = the log file exists with all eight items resolved to a branch, each with recorded output. Any item that cannot be completed for access reasons is recorded as blocked-with-reason, not skipped silently.

## Rollout / recovery

N/A — read-only. The only rollback is deleting the log file.

## Acceptance criteria

- [ ] `docs/audits/backend-audit-2026-08-12-verification.md` committed with all 8 items resolved or explicitly blocked.
- [ ] H-4, M-6, M-25, L-25, H-2, L-40 each have a recorded branch outcome.
- [ ] Downstream plans (01 Task 5, 03 Task 3, 09) reference the recorded outcomes instead of assumptions.
- [ ] Zero mutations performed (assert this explicitly in the log).

## Dependencies

- None — can run first, in parallel with Plans 01-03. Plan 09 (admin hardening) consumes Task 2 + Task 5 outcomes; Plan 01 consumes §15.1; Plan 03 consumes Task 6's Resend/Sentry names.

## Risks / unresolved questions

- Requires operator-level dashboard access (Cloudflare Zero Trust, Supabase settings, Sentry) — if the executing agent lacks access, each such item becomes a short operator checklist rather than an agent task (the log format stays the same).
- If multiple escalation branches fire at once (e.g. broad Access policy + legacy keys), prioritize: R2 public access > Access policy > missing prod secret > key rotation.
