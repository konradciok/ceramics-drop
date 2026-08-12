# Remediation 11 — Prodigi client & pipeline robustness (M-11 / M-12 / M-14 / M-26 / L-19 / L-24) — P2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §5 (Prodigi group), §9, §13 Opp-4/Opp-5(reconcile-mode). Evidence re-verified at HEAD `3da7ee0`. Sequence **after** Plans 02 and 05 (same files; rehearsal observations feed this plan).

**Goal:** Once the queue actually works (Plan 02), close the remaining silent-failure and hygiene modes in the Prodigi leg: hung requests, lost callbacks, unchecked order `outcome`, long-lived bearer URLs persisted forever, the env-flip idempotency collision, and the content-type precedence quirk.

**Architecture:** Point fixes in `src/server/prodigi/client.ts` (timeout), `process-job.ts` (outcome branch), `callbacks.ts` (redaction), plus a new cron-driven reconciliation sweep reusing the callback's re-fetch-and-merge logic — no new architecture; the cron already runs idempotent sweeps.

**Tech stack:** `AbortSignal.timeout` (pattern already in-repo: `worker.ts:155-156` Resend calls), Prodigi Print API v4 (https://www.prodigi.com/print-api/docs/reference/), existing fulfilment test suites.

## Objective

- A hung Prodigi endpoint cannot stall the queue consumer or the callback response indefinitely (M-11).
- A lost callback (transient 500 our side) cannot permanently freeze an order's fulfilment status — a cron poll reconciles non-terminal `prodigi_orders` (M-12/Opp-4).
- `CreatedWithIssues`/`OnHold` outcomes are surfaced instead of read as success (M-26).
- Signed asset URLs stop being 7-day bearer tokens persisted forever in `prodigi_raw_json` (M-14).
- A sandbox→live env flip cannot 5xx-loop on the per-order unique index (L-19).
- The signed asset route serves the DB-validated content type (L-24).

## Findings covered

- **M-11** (MEDIUM) → PLANNED
- **M-12** (MEDIUM `[UNVERIFIED]` retry semantics) → PLANNED (reconciliation makes the unknown retry semantics irrelevant)
- **M-14** (MEDIUM `[INFERENCE]`) → PLANNED
- **M-26** (MEDIUM) → PLANNED
- **L-19** (LOW) → PLANNED
- **L-24** (LOW) → PLANNED (cheap adjacency)
- **L-22** (contract assumptions) → observations recorded by Plan 05's rehearsal; any discrepancy found there lands as concrete steps here. → REQUIRES-VERIFICATION (input)
- **L-23** (`PRINT_ASSET_TOKEN_SECRET` rotation story) → **DEFERRED** to backlog — key-versioned HMAC rotation is listed in the audit's §13 extended ledger; not a defect today.
- **§6.11** (`in_production` stage reality) → settled by Plan 05's observation; if Prodigi v4 never emits it, remove the mapping (one line in `status-map.ts`) in this plan.

## Current-state evidence

All `VERIFIED` at HEAD `3da7ee0`:

- **M-11** — `src/server/prodigi/client.ts:51-63`: single shared `request<T>()` with plain `fetch`, no `signal`; used by all 11 methods (:97-147). In-repo timeout pattern exists (`worker.ts` Resend 8 s AbortController).
- **M-26** — `process-job.ts:187-190`: `const res = await client.postOrder(payload); prodigiOrderId = res.order.id;` — `res.outcome` (typed `'Created' | 'AlreadyExists' | string`, `types.ts:50`) never read anywhere in the file.
- **M-14** — `callbacks.ts:153-174` upsert persists `prodigi_raw_json: prodigiOrder` verbatim (:158) incl. the echoed signed asset URL. `redactSignedPrintAssetUrl` exists at `src/lib/print-asset-smoke.ts:23` (not `print-assets.ts` as the audit guessed) and is unused in callbacks. The 7-day TTL constant: locate where the fulfilment signing TTL is set (`src/lib/print-assets.ts` / `resolveSignedAssetUrl` chain) during implementation.
- **L-19** — `enqueue.ts:15`: `idempotencyKey = \`prodigi:${env.PRODIGI_ENV}:order:${orderId}:v1\`` — the key is env-namespaced, but the **DB uniqueness** is per-order (`fulfilment_jobs_order_unique` partial index + per-order constraints per `20260626120002:13-15`), so re-enqueueing the same order after an env flip collides → unconditional insert error → webhook 5xx loop (audit's essence; confirm the exact conflict site at implementation).
- **M-12** — no reconciliation poll exists; Prodigi callback retry semantics undocumented/unconfirmed.
- **L-24** — the signed route prefers R2 `httpMetadata` content-type over the DB-validated column (locate in `src/app/api/print-assets/[id]/route.ts` during implementation).
- `CONFIRMED-LIVE` (audit): 0 rows everywhere — no data-migration concerns for any of this.

## Desired end state

Prodigi calls time out and classify as retryable; a stuck non-terminal `prodigi_orders` row self-heals within a cron cycle or alerts; `outcome !== 'Created'` is recorded + alerted; persisted callback JSON carries redacted asset URLs and new fulfilment URLs live ≤ 48 h; env-flip re-enqueue converges instead of looping; asset responses use the validated content type.

## Scope

- `src/server/prodigi/client.ts`, `src/server/prodigi/callbacks.ts`, `src/server/fulfilment/process-job.ts`, `src/server/fulfilment/enqueue.ts`, `src/server/fulfilment/status-map.ts` (conditional)
- `worker.ts` cron section (one new sweep call) — coordinate with Plan 02's sweep structure
- `src/lib/print-assets.ts` (TTL constant), `src/lib/print-asset-smoke.ts` (move/export the redactor to a shared location, e.g. `src/lib/print-asset-redact.ts`, keeping the smoke import working)
- `src/app/api/print-assets/[id]/route.ts` (content-type precedence)
- Corresponding test files

## Out of scope

- Queue context/backoff (Plan 02 — merged before this).
- Any Prodigi *feature* work (new SKUs, shipping methods).
- `webhook_events` retention (Plan 14).
- Print-order reconcile **CLI** mode (Opp-5's `reconcile:orders` command) — **DEFERRED** to backlog unless the rehearsal's DLQ drill shows manual recovery is too clumsy; the cron sweep here covers the automated case.

## Implementation steps

### Task 1 — M-11: timeouts in the Prodigi client

- [ ] Failing test: a `fetch` that never resolves (mock with a hanging promise + fake timers) → `request()` rejects with `ProdigiError(retryable: true)` within the timeout.
- [ ] Add `signal: AbortSignal.timeout(PRODIGI_TIMEOUT_MS)` (15 000 ms; constant at top of `client.ts`) to the fetch; map `TimeoutError`/`AbortError` into the existing `ProdigiError(…, null, true)` network branch (:62).
- [ ] Green + commit: `fix(prodigi): 15 s timeout on all Prodigi calls (M-11)`

### Task 2 — M-26: branch on `outcome`

- [ ] Failing tests (process-job suite): `outcome: 'Created'`/`'AlreadyExists'` → current behaviour; `outcome: 'CreatedWithIssues'` → order id still recorded, but job/status notes the issues (persist the `issues` array into `fulfilment_jobs.last_error` or a dedicated field — prefer `last_error` to avoid a migration) and a studio alert fires; `outcome: 'OnHold'` → same treatment.
- [ ] Implement after `:189`: read `res.outcome`; on non-`Created`/`AlreadyExists`, record + alert (reuse the failed-action alert helper family), but do **not** throw (the order exists at Prodigi; throwing would retry-create). Exact severity mapping per outcome value from the Prodigi docs — confirm the current outcome enum at implementation.
- [ ] Green + commit: `fix(fulfilment): surface non-Created Prodigi outcomes (M-26)`

### Task 3 — M-12/Opp-4: cron reconciliation sweep

- [ ] Extract the callback's re-fetch-and-merge into a reusable function if not already separable (`callbacks.ts` re-fetches order state from Prodigi and merges — identify the seam; the sweep must reuse, not duplicate, the merge logic).
- [ ] New sweep (pattern of Plan 02 Task 3): `prodigi_orders` rows whose `prodigi_status_stage` is non-terminal and `updated_at < now() - interval '6 hours'` → `client.getOrder(prodigi_order_id)` → run the same merge; if the merge advances nothing twice in a row, alert (`prodigi_order_stalled`). Batch-limited (≤ 10/run), timeout-protected (Task 1).
- [ ] Unit tests: a stale `InProgress` row advances on poll; an already-terminal row is skipped; a Prodigi 404 alerts.
- [ ] Green + commit: `feat(fulfilment): cron reconciliation for stale Prodigi orders (M-12)`

### Task 4 — M-14: TTL + redaction

- [ ] Shorten the **fulfilment** signed-URL TTL from 7 days to 48 h (locate the constant; keep any storefront/gallery signing paths untouched — fulfilment only). Guard: Prodigi may fetch assets late for delayed production — 48 h covers submission-time download (Prodigi downloads at order intake); note this assumption and cross-check with the rehearsal's observation of when assets are pulled.
- [ ] Move `redactSignedPrintAssetUrl` to a shared module; in `callbacks.ts`, deep-redact asset URLs in `prodigiOrder` before the upsert at :158 (walk `items[].assets[].url` per the v4 shape; redact query `sig`/token params, keep the path for debuggability).
- [ ] Tests: persisted JSON contains no `sig=` (assert on the upsert payload); smoke-test import still works.
- [ ] Green + commit: `fix(prodigi): 48 h fulfilment URL TTL; redact signed URLs from persisted callbacks (M-14)`

### Task 5 — L-19 + L-24: hygiene pair

- [ ] L-19: at the enqueue/insert conflict site, handle the per-order unique violation gracefully when the existing row belongs to a **different `PRODIGI_ENV`**: fail the job to `failed_action_required` with a clear `last_error` (`env_flip_conflict`) instead of an unconditional throw→5xx loop. Test: seeded sandbox-era row + live re-enqueue → no throw, actionable status.
- [ ] L-24: in the signed asset route, serve the DB-validated content-type column, falling back to R2 `httpMetadata` only when the column is null. Test both orders of precedence.
- [ ] Green + commit: `fix(fulfilment): graceful env-flip conflict; DB-validated content type on asset route (L-19, L-24)`

### Task 6 — conditional: `in_production` mapping

- [ ] Read Plan 05's rehearsal observation. If sandbox callbacks never surfaced `InProduction` **and** the Prodigi docs confirm v4 doesn't emit it: remove the `InProduction: 'in_production'` mapping line (`status-map.ts:9-15`) + its test expectations; else keep and close §6.11 as confirmed-working.

## Database / migration work

None required (Task 2 reuses `last_error`; Task 3 reads existing columns). If implementation finds `last_error` too narrow for the issues array, prefer truncation over a migration.

## External-system changes

None mutating. Prodigi sandbox may be used for targeted verification (sandbox mutations = standard gate, same as Plan 05). The TTL change affects only newly-minted URLs.

## Tests

- **New:** timeout rejection; outcome matrix; reconciliation sweep (advance/skip/404-alert); redaction assertion; env-flip conflict; content-type precedence.
- **Extended:** `process-job.test.ts` grows the outcome cases; callbacks tests grow the redaction case.
- **Failure modes simulated:** hung endpoint; `CreatedWithIssues`; lost callback (stale row); env flip; missing DB content type.

## Verification

- **Local/unit:** `npx vitest run src/server/` — paste (full fulfilment + prodigi suites green). `npm run lint && npm run typecheck && npm test`.
- **Preview/sandbox:** one sandbox order via `npm run prodigi -- …` or a preview checkout; confirm the persisted `prodigi_raw_json` has redacted URLs; optionally simulate a stale row (backdate `updated_at`) and watch the sweep advance it in `wrangler tail`.
- **Live read-only:** post-deploy, no change expected (0 rows live); watch the first real print order's raw JSON for redaction.
- **Live mutation:** none.

## Rollout / recovery

1. Single PR after Plans 02/05. **Rollback:** revert; no state to unwind (0 rows in prod).
2. **Stop signals:** rehearsal-derived — if Prodigi pulls assets later than 48 h post-submission (Task 4 assumption broken), bump the TTL back and re-plan redaction-only.

## Acceptance criteria

- [ ] All new unit tests green (pasted run).
- [ ] A sandbox order's persisted callback JSON contains no signed query params.
- [ ] A backdated non-terminal `prodigi_orders` row is advanced or alerted by the sweep in preview.
- [ ] `CreatedWithIssues` produces an alert without a retry-create loop (unit).
- [ ] Env-flip conflict yields `failed_action_required`, not a 5xx loop (unit).
- [ ] §6.11 resolved (mapping kept-with-evidence or removed).

## Dependencies

- **Plan 02** (same files, must merge first), **Plan 05** (rehearsal observations feed Tasks 4/6; its L-22 notes may add steps here), **Plan 03** (alert channels). Plan 14's retention cron is independent despite both touching the cron section — coordinate merge order ad hoc.

## Risks / unresolved questions

- When exactly Prodigi downloads assets (order intake vs production start) decides the safe TTL floor — rehearsal observation required before Task 4 merges.
- The callback merge seam may not extract cleanly; if reuse requires >~50 lines of refactor, stop and do the minimal poll-and-alert (skip auto-merge) instead — alerting is the non-negotiable part of M-12.
