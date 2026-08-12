# Remediation 08 — Env completeness & DR-provisioning guard (M-17) — P1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §5 M-17, §13 Opp-12 (env-var completeness test). Evidence re-verified at HEAD `3da7ee0`.

**Goal (scoped to documentation completeness — not a provisioning guarantee):** keep `.env.example` a complete, machine-checked catalogue of the runtime-required variables, so a disaster-recovery operator provisioning from it has every name in front of them. **An `.env.example` entry does not *provision* a Cloudflare Worker secret** — an uncommented `KEY=` line documents that a value is needed, it does not install it. This guard therefore closes the "the operator never knew the variable existed" half of M-17; the "the value is actually set in prod" half is owned by **Plan 04's secret-presence sweep** plus a post-provision checkout smoke test. Do not claim this plan alone guarantees DR checkout availability.

**Architecture:** `.env.example` additions + one guard test in `scripts/` (the tripwire pattern of `build-config.test.ts`), cross-checking the non-optional keys declared in `cloudflare-env.d.ts` against `.env.example` — the type declaration file is the machine-readable source of truth for "required".

**Tech stack:** Vitest (scripts glob), plain fs parsing.

## Objective

Anyone provisioning a fresh environment from `.env.example` gets every runtime-required variable **named** (documentation completeness), and CI fails when a new required env reference lands without an `.env.example` entry. Actual prod-secret **presence** is verified separately (Plan 04 Task 6 + a post-provision checkout smoke) — this plan does not assert values are set.

## Findings covered

- **M-17** (MEDIUM) → PLANNED
- **Opp-12 (env test half)** → PLANNED (the `cancelIntent` extraction half of Opp-12 is Plan 12)
- Adjacent (from inspection, part of the same gap): the three `ADMIN_*` local-override vars are invisible to typings and `.env.example` (see L-30 in Plan 09) — documented here as **optional** entries.

## Current-state evidence

- `VERIFIED` `.env.example` (184 lines) — **absent:** `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`, `CMS_PREVIEW_SECRET` (grep = 0 hits). Both are runtime-required: `src/app/api/checkout/route.ts:259-261` fails checkout 502 without the PMC id; `src/lib/cms/server.ts:20-21` throws without the preview secret. Both are non-optional in `cloudflare-env.d.ts` (:18, :68).
- `VERIFIED` — present already: `NEWSLETTER_CONFIRM_SECRET` (:42), `ADMIN_ALLOWED_EMAILS` (:116), `PRODIGI_CALLBACK_TOKEN` (:163), `PRINT_ASSET_TOKEN_SECRET` (:165), `FULFILMENT_DEBUG_TOKEN` (:184).
- `VERIFIED` — no existing test reads `.env.example` (grep across ts/js/mjs = only a human-facing error string in `scripts/gtm-api.mjs:561`); `scripts/lib/script-env.test.ts` tests parsing only, with mocked fs.
- `VERIFIED` — `cloudflare-env.d.ts` declares required (non-`?`) vs optional (`?`) keys; `ADMIN_SUPABASE_URL`/`ADMIN_SUPABASE_SERVICE_ROLE_KEY`/`ADMIN_STRIPE_SECRET_KEY` are deliberately absent from it (`src/lib/admin/clients.ts:15-16` widens the type instead).

## Desired end state

`.env.example` names every variable the runtime can require, with the same comment style as the existing entries (where it's set: Workers Build env vs `wrangler secret put` vs `.dev.vars`); a guard test enforces the invariant.

## Scope

- `.env.example`
- New `scripts/env-example-completeness.test.ts`
- (Docs) one line in `docs/cloudflare-deployment.md` DR notes if such a section exists

## Out of scope

- Changing any runtime env handling or fail-closed behaviour (all correct today).
- The `ADMIN_*` override *semantics* (Plan 09 / L-30).
- Verifying prod secret presence (Plan 04 Task 6).

## Implementation steps

- [ ] **Failing test first.** `scripts/env-example-completeness.test.ts`:
  - **Fail closed on parser misses:** first assert the `CloudflareEnv` interface was actually found in `cloudflare-env.d.ts` **and** that the parsed required-key set is non-empty. If either assertion fails, the test **fails** (a silent regex miss must never let the completeness check pass vacuously).
  - Parse `cloudflare-env.d.ts` for declared key names, splitting required (no `?`) from optional (`?`).
  - Parse `.env.example` twice, distinguishing **active** entries (`^\s*([A-Z0-9_]+)=`, uncommented) from **commented-out** entries (`^\s*#\s*([A-Z0-9_]+)=`). A commented entry documents a name but does **not** provision it when an operator copies `.env.example` to `.env`.
  - Assert every **required** key from the type file has an **active (uncommented) `KEY=` line** in `.env.example` (empty value is fine — the point is the line survives a copy so the operator sees it must be filled). A commented-out required key **fails** the test — that is exactly the M-17 failure mode (a DR redeploy silently omits `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` / `CMS_PREVIEW_SECRET` and every checkout 502s). Comment-only entries are permitted **only** for optional keys or allowlisted non-provisioned bindings (e.g. `FULFILMENT_QUEUE`, `PRINT_ASSETS`, `ASSETS`, `WORKER_SELF_REFERENCE` — binding names live in `wrangler.jsonc`, not env files; also `NEXT_PUBLIC_APP_VERSION`, build-inlined), each with a justification comment.
  - Second assertion (drift the other way): every config name referenced in `src/**` + `worker.ts` is either declared in `cloudflare-env.d.ts` or on the allowlist — this catches the `ADMIN_*`-style untyped escape hatch next time. **Define the scan scope explicitly and cover every access form actually used in the repo:** both `env.<NAME>` / `env['<NAME>']` **and** `process.env.<NAME>` (the codebase reads `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `NODE_ENV`, `NEXT_RUNTIME` via `process.env` — e.g. `src/lib/sentry-options.ts`, `next.config.ts`). **Scan the build-config files too, not only `src/**` + `worker.ts`:** `next.config.ts` reads `process.env` (e.g. it inlines `NEXT_PUBLIC_APP_VERSION`), and other build-config files may read env vars — include `next.config.ts` (and any sibling build config that reads env) in the scan roots. Either include `process.env.<NAME>` reads across all those roots (allowlisting build/runtime intrinsics like `NODE_ENV`/`NEXT_RUNTIME`), or, if a build-config file's `process.env` names are deemed out of scope, **document and test that boundary explicitly** (assert its known `process.env` names are the allowlisted set) rather than silently omitting the file. Prefer covering them — an ad-hoc regex that misses `process.env` or skips `next.config.ts` would let a future `process.env.NEW_SECRET` escape the guard.
- [ ] Run it — expect FAIL naming exactly `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` and `CMS_PREVIEW_SECRET` (plus the `ADMIN_*` trio on the second assertion).
- [ ] Add the two required entries as **active (uncommented) `KEY=` lines** in `.env.example` with explanatory comments matching neighbours (mode-specific PMC id, `wrangler secret put` instruction, checkout-fails-closed note; dedicated HMAC secret, never reuse others — mirror the audit/AGENTS.md language). Add the three optional `ADMIN_*` vars as a **commented** local-only block (they are optional overrides — comment form is correct for them) referencing `src/lib/admin/clients.ts`.
- [ ] Adjust the allowlist until the test is green for the *right* reasons (each allowlist entry gets a one-line justification comment).
- [ ] Run `npm test` (the scripts glob collects it) — green.
- [ ] Commit: `fix(env): document required checkout/CMS secrets in .env.example + completeness guard (M-17)`

## Database / migration work

None.

## External-system changes

None. (`.env.example` values stay empty placeholders — never commit real values.)

## Tests

- **New:** the completeness test (two assertions as above).
- **Regressions caught:** a future `env.NEW_SECRET` requirement merged without documentation; a future untyped env read.
- **Simulated:** run the test before the `.env.example` edit to prove it detects today's gap (the ordered commits demonstrate it).

## Verification

- **Local:** `npx vitest run scripts/env-example-completeness.test.ts` — paste the pre-fix FAIL and post-fix PASS. `npm test` green.
- No preview/live steps.

## Rollout / recovery

Docs+test only; no runtime impact; revert freely.

## Acceptance criteria

- [ ] `.env.example` contains `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`, `CMS_PREVIEW_SECRET`, and the optional `ADMIN_*` block.
- [ ] The guard test fails when either required entry is removed (demonstrated), passes at HEAD.
- [ ] `npm test` green.

## Dependencies

None. Fully independent; good first P1 to land.

## Risks / unresolved questions

- Parsing `cloudflare-env.d.ts` by regex is intentionally simple; if the file's shape ever changes (namespaces, mapped types), the test fails loudly rather than silently passing — acceptable.
