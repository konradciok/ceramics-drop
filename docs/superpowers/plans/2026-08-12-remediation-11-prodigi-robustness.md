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

- [ ] **Use `AbortController` + `setTimeout(...).abort()` — one recommendation, matching the repo's proven precedent.** The in-repo timeout precedent (`worker.ts:155-156` Resend calls) uses `AbortController` + `setTimeout`, **not** `AbortSignal.timeout()`; the repo uses the `AbortController` pattern for its timeouts. Standardize on it here rather than introducing `AbortSignal.timeout()` (whose availability in the targeted `workerd`/installed types is not confirmed in-repo). Define `PRODIGI_TIMEOUT_MS = 15_000` as a constant at the top of `client.ts` and clear the timer in a `finally` so a fast response doesn't leak a pending abort.
- [ ] Failing test: a `fetch` that never resolves (mock with a hanging promise + fake timers) → `request()` rejects with a `ProdigiError` whose `retryable` is **true**, within the timeout. Explicitly assert the timeout error is mapped to the **retryable** branch — an unmapped `AbortError` could otherwise fall through as a non-retryable error and get acked instead of retried.
- [ ] Add the timeout signal to the shared `request<T>()` fetch; map `TimeoutError`/`AbortError` into the existing `ProdigiError(…, null, true)` network branch (:62) so a timeout is retryable (→ backoff/DLQ), never a silent ack.
- [ ] Green + commit: `fix(prodigi): 15 s retryable timeout on all Prodigi calls (M-11)`

### Task 2 — M-26: branch on `outcome`

- [ ] **Persist `prodigi_orders` for *every* created remote order, before finalizing status — single finalization path.** `CreatedWithIssues` and `OnHold` both mean Prodigi **created** an order, so the existing `prodigi_orders` upsert (currently done after the POST) MUST run for them too, *before* the outcome branch sets the final status and returns. Task 3's reconciliation can only re-poll rows that exist in `prodigi_orders`; a branch that returns early without the upsert would strand a real remote order untracked. Order of operations for all non-error outcomes: (1) upsert `prodigiOrderId` into `prodigi_orders`, then (2) apply the final `fulfilment_jobs` status per the contract below.
- [ ] **Outcome → status/alert/retry contract** (`process-job.ts` currently marks *every* successful POST `fulfilment_submitted`):
  - `Created` / `AlreadyExists` → `fulfilment_submitted`, no alert (current happy path).
  - `CreatedWithIssues` → order exists → status `fulfilment_submitted` + persist the `issues` + studio alert. **Do not throw** (would retry-create a duplicate). Reconciliation (Task 3) keeps tracking it.
  - `OnHold` → order exists but won't progress without action → `failed_action_required` (the human-attention status the cron sweep already surfaces) + persist the reason + alert. Not terminal-success, not a retry-create.
  - Unknown/other `outcome` → treat as `CreatedWithIssues` (record + alert), never silently as success.
- [ ] **Persist the `issues` diagnostics without silent truncation** (M-26 detail): confirm the type/size limit of the target column first. `fulfilment_jobs.last_error` is free-text — if the serialized `issues` array risks exceeding a practical bound, serialize as JSON and, only if truncation is unavoidable, keep the provider issue **codes** and append an explicit `…[truncated]` marker (never emit invalid/partial JSON). If `last_error` proves too narrow to preserve the codes+messages studio action needs, persist the full `issues` into the JSON `prodigi_raw_json` field instead. Silent truncation that discards issue codes is not acceptable — the studio needs them to act.
- [ ] **Status-vocabulary coordination:** no new status string is introduced (reusing `fulfilment_submitted` / `failed_action_required`), so this stays within the CHECK constraint added by Plan 07 (L-13). If implementation adds a status value, extend that CHECK in lockstep.
- [ ] Failing tests (process-job suite): one per outcome — `Created`/`AlreadyExists` (submitted, `prodigi_orders` row written, no alert); `CreatedWithIssues` (`prodigi_orders` written **before** status, submitted + issues persisted without truncation-loss + alert, no throw, no re-create); `OnHold` (`prodigi_orders` written, `failed_action_required` + alert); unknown outcome (treated as issues). Assert the `prodigi_orders` upsert happens for the issues/on-hold branches, not just the happy path.
- [ ] Implement after `:189`: run the `prodigi_orders` upsert, then read `res.outcome` and branch per the contract through one finalization path; reuse the failed-action alert helper family. Confirm the current outcome enum against the Prodigi docs at implementation (the unknown-outcome branch covers additions safely).
- [ ] Green + commit: `fix(fulfilment): persist prodigi_orders + branch on Prodigi outcome (M-26)`

### Task 3 — M-12/Opp-4: cron reconciliation sweep

- [ ] Extract the callback's re-fetch-and-merge into a reusable function if not already separable (`callbacks.ts` re-fetches order state from Prodigi and merges — identify the seam; the sweep must reuse, not duplicate, the merge logic).
- [ ] **Do not gate the stale sweep on `updated_at`** — the shared merge writes `updated_at = now()` on **every** upsert, so a no-op reconciliation poll would refresh `updated_at` and hide the row from a `updated_at < now() - 6h` predicate forever (the sweep would keep resetting its own clock). Use dedicated columns instead (tiny additive migration): `last_reconciled_at timestamptz` (when the sweep last polled) and `stalled_poll_count smallint` (consecutive no-progress polls). The sweep predicate is `prodigi_status_stage` non-terminal **and** `coalesce(last_reconciled_at, updated_at) < now() - interval '6 hours'`; only **meaningful provider progress** (a changed `prodigi_status_stage`) bumps `updated_at` and resets `stalled_poll_count` to 0, while every poll sets `last_reconciled_at = now()` and increments `stalled_poll_count` when nothing advanced.
- [ ] New sweep (pattern of Plan 02 Task 3): select the stale non-terminal rows → `client.getOrder(prodigi_order_id)` → run the shared merge → update `last_reconciled_at`/`stalled_poll_count` per above → alert `prodigi_order_stalled` once `stalled_poll_count` reaches 2. Batch-limited (≤ 10/run), timeout-protected (Task 1). Skip terminal rows.
- [ ] Unit tests: a stale `InProgress` row advances on poll (status bumped, `stalled_poll_count` reset); a **no-op poll does NOT refresh `updated_at`** and the row is still selectable by the next sweep (proves the reconciliation clock is separate from the progress clock); two consecutive no-progress polls → `prodigi_order_stalled` alert; an already-terminal row is skipped; a Prodigi 404 alerts.
- [ ] Green + commit: `feat(fulfilment): cron reconciliation for stale Prodigi orders (M-12)`

### Task 4 — M-14: TTL + redaction

- [ ] Shorten the **fulfilment** signed-URL TTL from 7 days to 48 h (locate the constant; keep any storefront/gallery signing paths untouched — fulfilment only). Guard: Prodigi may fetch assets late for delayed production — 48 h covers submission-time download (Prodigi downloads at order intake); note this assumption and cross-check with the rehearsal's observation of when assets are pulled.
- [ ] Move `redactSignedPrintAssetUrl` to a shared module and deep-redact **both** persisted payloads in `callbacks.ts`, not just one:
  - `prodigi_orders.prodigi_raw_json` — the fetched order object (`prodigiOrder`) before the upsert at :158.
  - `webhook_events.raw_json` — the **inbound callback request body** the route stores (the body can also echo `items[].assets[].url`).
  Recursively walk `items[].assets[].url` per the v4 shape, strip query `sig`/token params, keep the path + `exp` for debuggability. If it can be proven the callback body can never contain asset URLs, document that instead — but default to sanitizing both.
- [ ] Tests: assert **each** persisted payload (`prodigi_raw_json` and `webhook_events.raw_json`) contains no `sig=` value while path + `exp` remain, using a nested `items[].assets[].url` fixture with both `exp` and `sig`; smoke-test import still works.
- [ ] Green + commit: `fix(prodigi): 48 h fulfilment URL TTL; redact signed URLs from persisted callbacks (M-14)`

### Task 5 — L-19 + L-24: hygiene pair

- [ ] L-19: reliable env-flip detection. **The blocker:** `fulfilment_jobs` has **no persisted `PRODIGI_ENV` column** — the environment appears only inside `idempotency_key` (`prodigi:${env}:order:${orderId}:v1`), while the uniqueness is per `order_id`. So the conflict handler cannot naively assume "unique violation == env flip." Choose one discriminator and implement it precisely:
  - **Preferred (with legacy handling):** add a persisted `fulfilment_jobs.prodigi_env text` column (tiny additive migration, backward-compatible) written on enqueue. **But a nullable column with no backfill leaves pre-deploy rows `NULL`**, so a sandbox→live conflict on an *existing* row still can't compare envs. Handle legacy rows: either backfill `prodigi_env` from parseable existing `idempotency_key` values in the migration, **or** fall back to the strict key parser (below) whenever the column is `NULL`. The column and parser are **not** mutually exclusive — legacy data needs the parser fallback.
  - **No-migration:** a strict parser that extracts the env from the existing row's `idempotency_key`. Match the **full** key format, not just the prefix: `^prodigi:(sandbox|live):order:[^:]+:v1$` (a prefix-only regex would accept malformed/future keys with arbitrary suffixes and could misclassify an unrelated violation as an env flip). Reject any key missing/adding segments rather than guessing.
- [ ] Classify `env_flip_conflict` **only** when *all* hold: the DB error is a unique violation **named `fulfilment_jobs_order_unique`** (check the constraint name, not just SQLSTATE `23505`), **and** the existing active row for the same `order_id` has a **different** env than the current `PRODIGI_ENV`. In that case fail the job to `failed_action_required` with `last_error='env_flip_conflict'` (no throw→5xx loop). **Every other** unique violation — same-env duplicate (a genuine idempotent retry), or a violation on a *different* constraint — must **propagate through the existing retry/error path** unchanged, not be swallowed as an env flip.
- [ ] Tests (three cases the finding names): (a) sandbox-era row + live re-enqueue → `env_flip_conflict`, `failed_action_required`, no throw; (b) same-env duplicate enqueue → handled by the existing idempotent path, **not** classified as env flip; (c) an unrelated unique violation (different constraint) → propagates as an error, not swallowed.
- [ ] L-24: in the signed asset route, serve the DB-validated content-type column, falling back to R2 `httpMetadata` only when the column is null. Test both orders of precedence.
- [ ] Green + commit: `fix(fulfilment): graceful env-flip conflict; DB-validated content type on asset route (L-19, L-24)`

### Task 6 — conditional: `in_production` mapping

- [ ] Read Plan 05's rehearsal observation. If sandbox callbacks never surfaced `InProduction` **and** the Prodigi docs confirm v4 doesn't emit it: remove the `InProduction: 'in_production'` mapping line (`status-map.ts:9-15`) + its test expectations; else keep and close §6.11 as confirmed-working.

## Database / migration work

All additions below are **additive, backward-compatible** (old code ignores new columns; auto-apply on merge). Task 2 persists `issues` into existing columns (`last_error` / `prodigi_raw_json`).

**Task 3 (reconciliation clock — required for the sweep to work):** `alter table prodigi_orders add column if not exists last_reconciled_at timestamptz;` and `add column if not exists stalled_poll_count smallint not null default 0;`. Without these the sweep would refresh its own `updated_at` on no-op polls and never fire (see Task 3). No backfill needed — a `NULL last_reconciled_at` falls back to `updated_at` in the predicate.

**Task 5 (env discriminator — preferred path):** `alter table fulfilment_jobs add column if not exists prodigi_env text;` written on enqueue. **Backfill legacy rows** in the same migration from parseable `idempotency_key` values (`update fulfilment_jobs set prodigi_env = substring(idempotency_key from '^prodigi:(sandbox|live):') where prodigi_env is null and idempotency_key ~ '^prodigi:(sandbox|live):order:[^:]+:v1$';`), and keep the strict-parser fallback in code for any row still `NULL`. If the migration is undesired entirely, the no-migration strict-parser variant classifies without it — but then there is no column to backfill and the parser is the sole path.

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
