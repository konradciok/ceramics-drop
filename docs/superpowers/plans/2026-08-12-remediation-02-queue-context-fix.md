# Remediation 02 — Prodigi queue context fix (C-2 / M-10 / M-23 / L-21 / Opp-6) — P0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` (§4 C-2, §5 M-10/M-23, L-21, §13 Opp-6, §15.2). Evidence re-verified at HEAD `3da7ee0` on 2026-08-12.

**Goal:** Make automated print fulfilment actually work in production: the queue consumer must stop depending on the request-scoped AsyncLocalStorage context, stranded jobs must become visible, retries must back off, and a regression guard must prevent reintroduction.

**Architecture:** `processJob` (and the asset repository call it makes) currently builds Supabase clients via `getSupabaseAdmin()` → `getCloudflareContext()`, which throws outside the `fetch` handler's ALS. The fix mirrors the pattern the same file's authors already use in `scheduled()`: construct clients from the explicit `env` (`supabaseFromEnv(env)`) and thread them down. A file-content tripwire test (mirroring `scripts/build-config.test.ts`) prevents regression. This is a **P0 pre-launch blocker for prints** — prints are purchasable today and the first sale currently dead-letters after 10 fruitless retries.

**Tech stack:** Cloudflare Queues, OpenNext ALS internals, Vitest.

## Objective

Fix the guaranteed-failure path: every production queue delivery currently throws `getCloudflareContextSync` before any DB write (no claim, no `last_error`), burns all 10 retries with **zero log output** (L-21), dead-letters, and leaves the `fulfilment_jobs` row stranded in `queued` — a status the cron sweep never looks at (M-10). Customer paid; nothing reached Prodigi; nothing visibly recorded why.

## Findings covered

- **C-2** (HIGH, P0) — queue consumer calls `getCloudflareContext()` outside the request ALS → every job dead-letters. → PLANNED
- **M-10** (MEDIUM) — no watchdog for jobs stranded in `queued` / `fulfilment_submitting` / `failed_retryable`; sweep covers only `failed_action_required`. → PLANNED
- **M-23** (MEDIUM) — no retry backoff; 10 retries burn in seconds. → PLANNED (same handler, ~3 lines)
- **L-21** (LOW) — queue consumer swallows the caught error with no log for the entire 10-delivery lifetime. → PLANNED (same handler)
- **Opp-6** — queue-context regression guard. → PLANNED
- **L-15** (LOW) — pipeline never run in prod → runtime validation happens in **Plan 05** (rehearsal), which is this plan's exit gate.

## Current-state evidence

All `VERIFIED` at HEAD `3da7ee0`:

- `VERIFIED` `worker.ts:63-70` — `queue()` iterates `batch.messages` and calls `processJob(msg.body, env, ctx)` directly; no ALS wrapper exists in source (the generated OpenNext bundle wraps only `fetch`).
- `VERIFIED` `worker.ts:66-69` — `.catch((err) => { if (decideMessageDisposition(err) === 'ack') msg.ack(); else msg.retry(); })` — `err` is never logged; `msg.retry()` takes no options (no `delaySeconds`).
- `VERIFIED` `src/server/fulfilment/process-job.ts:92-99` — signature `(msg, env, _ctx)`; first DB op is `const supabase = getSupabaseAdmin();` (:99). `_ctx` is unused.
- `VERIFIED` `src/lib/supabase.ts` (18 lines) — `supabaseFromEnv(env)` exists precisely for "contexts without request ALS (e.g. the scheduled/cron handler)" (:4-8); `getSupabaseAdmin()` = `supabaseFromEnv(getCloudflareContext().env)` (:16-18). The doc comment names scheduled/cron but not `queue()` — the consumer was simply missed.
- `VERIFIED` `src/server/print-assets/repository.ts:138-159` — `getAssetForFulfilment` builds a **second** ALS-dependent client (`getSupabaseAdmin()` at :141), reached from `processJob` via `resolveSignedAssetUrl` (`process-job.ts:36`).
- `VERIFIED` `src/server/fulfilment/queue-disposition.ts:9-12` — a plain `Error` (including the ALS TypeError) → `'retry'` → `max_retries: 10` → DLQ (`wrangler.jsonc:39-51`, `dead_letter_queue: "prodigi-fulfilment-dlq"`).
- `VERIFIED` `src/server/fulfilment/enqueue.ts:47-57` — when `FULFILMENT_QUEUE` is unset, `processJob` runs inline inside the webhook's fetch ALS — which is why local dev never sees the bug. No guard/warn distinguishes a deliberately-unset local env from a production binding regression.
- `VERIFIED` `src/server/fulfilment/process-job.test.ts:28` — `vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }))`, and `@/server/print-assets/repository` is mocked too (:40-42) — no test can observe the missing-ALS failure.
- `VERIFIED` `worker.ts:259-264` — the cron fulfilment sweep selects only `.eq('status', 'failed_action_required')`; `queued`/`fulfilment_submitting`/`failed_retryable` rows are invisible forever.
- `VERIFIED` `scripts/build-config.test.ts` — the in-repo tripwire pattern (readFileSync + "do not weaken" comment), collected by the `scripts/**/*.test.ts` vitest glob.
- `VERIFIED` `eslint.config.mjs` — flat config; rules scoped to `files: ['src/**/*.{ts,tsx}']`; no `no-restricted-imports` rule exists today.
- `CONFIRMED-LIVE` (audit) — `fulfilment_jobs` = 0 rows, `prodigi_orders` = 0 rows in prod: the bug is latent, never fired. Print pricing is live, so the feature is purchasable.
- `NEEDS-RUNTIME-VERIFICATION` — the throw has never been observed in a real queue delivery (§15.2). The rehearsal in Plan 05 settles it *after* this fix lands (expected outcome then: success, not throw).

## Desired end state

- A queued print job processes to completion in the real Workers queue runtime: claims the job, resolves the signed asset, posts to Prodigi (sandbox in rehearsal), records `prodigi_orders`.
- Any queue error is logged (structured JSON incl. `orderId`, attempt number, error) before ack/retry, and retried with exponential backoff.
- Jobs stuck in any non-terminal status for > 2 h surface through the same alert machinery as `failed_action_required` jobs.
- A tripwire test fails the build if `getSupabaseAdmin` / `getCloudflareContext` (or modules that resolve them) are referenced under `src/server/fulfilment/`.

## Scope

- `worker.ts` — queue handler only (logging, backoff) + the cron sweep's job query (M-10). No other worker.ts changes (Sentry init is Plan 03; worker tests are Plan 12).
- `src/server/fulfilment/process-job.ts`, `src/server/fulfilment/enqueue.ts` (warn on inline fallback only)
- `src/server/print-assets/repository.ts` — `getAssetForFulfilment` client injection
- `src/server/fulfilment/process-job.test.ts` and the repository's tests
- New: `scripts/queue-context-guard.test.ts`
- Optionally `eslint.config.mjs` (a scoped `no-restricted-imports` block as a second layer)

## Out of scope

- Worker-scope Sentry init (Plan 03) — the new logging should call `Sentry.captureException` only if Plan 03 has landed; otherwise structured `console.error` (which Workers Logs persists at 100% sampling) is the deliverable here.
- Prodigi client timeouts / `outcome` handling / reconciliation (Plan 11).
- Any refactor of `process-job`'s business logic, statuses, or the callback path.
- The DLQ consumer (already ALS-safe — it uses `env`-based clients).

## Implementation steps

### Task 1 — de-ALS `processJob` (the C-2 fix)

- [ ] **Failing test first.** In `src/server/fulfilment/process-job.test.ts`, replace the `vi.mock('@/lib/supabase', …)` of `getSupabaseAdmin` with a mock of `supabaseFromEnv` (same shape), and make `getSupabaseAdmin` **throw** in the mock — mirroring its real behaviour outside ALS:

```ts
vi.mock('@/lib/supabase', () => ({
  supabaseFromEnv: () => ({ from: mockFrom }),
  getSupabaseAdmin: () => { throw new Error('getCloudflareContext outside ALS'); },
}));
```

- [ ] Run `npx vitest run src/server/fulfilment/process-job.test.ts` — expect FAIL (current code calls the throwing `getSupabaseAdmin`). This is the executable proof of C-2 at unit level.
- [ ] In `src/server/fulfilment/process-job.ts:99`, change `const supabase = getSupabaseAdmin();` → `const supabase = supabaseFromEnv(env);` and fix the import. `env` is already a parameter — no signature change needed.
- [ ] In `src/server/print-assets/repository.ts`, change `getAssetForFulfilment` to take the client as a required first parameter (`getAssetForFulfilment(supabase: SupabaseClient, …)`), deleting its internal `getSupabaseAdmin()` (:141). Update every caller: `processJob` passes its `supabaseFromEnv(env)` client through `resolveSignedAssetUrl`; fetch-path callers (find them via typecheck errors) pass `getSupabaseAdmin()` at the call site. Requiring the parameter (not defaulting it) is deliberate — a default would silently reintroduce the ALS dependency.
- [ ] Un-mock `@/server/print-assets/repository` in `process-job.test.ts` only if the injection changes the mock surface; otherwise update the mock signature.
- [ ] Run `npx vitest run src/server/fulfilment/ src/server/print-assets/` and `npm run typecheck` — expect PASS.
- [ ] Commit: `fix(fulfilment): build Supabase clients from env in the queue path (C-2)`

### Task 2 — log + back off in the queue handler (L-21, M-23)

- [ ] In `worker.ts:63-70`, log before disposition and add exponential backoff:

```ts
.catch((err) => {
  const disposition = decideMessageDisposition(err);
  console.error(JSON.stringify({
    event: 'fulfilment_queue_error',
    orderId: msg.body?.orderId,
    attempt: msg.attempts,
    disposition,
    error: String(err),
  }));
  if (disposition === 'ack') msg.ack();
  else msg.retry({ delaySeconds: Math.min(2 ** msg.attempts * 30, 3600) });
});
```

  (Backoff: 60 s, 120 s, 240 s … capped at 1 h — a few-second vendor blip no longer burns all 10 retries into the DLQ in seconds. Confirm the exact `retry()` options shape against current Cloudflare docs at implementation time: https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [ ] In `src/server/fulfilment/enqueue.ts`, add a structured `console.warn({ event: 'fulfilment_inline_fallback' })` in the no-binding branch so a production binding regression is at least visible in logs.
- [ ] Commit: `fix(worker): log queue errors and retry with backoff (L-21, M-23)`

### Task 3 — widen the stranded-job sweep (M-10)

- [ ] Extend the cron fulfilment sweep in `worker.ts` (currently :256-264) with a second query: `fulfilment_jobs` where `status IN ('queued','fulfilment_submitting','failed_retryable')` **and** `updated_at < now() - interval '2 hours'` **and** `alerted_at IS NULL`. Route matches through the **same** alert machinery as the existing `failed_action_required` path (email + `Sentry.captureMessage`), with a distinct event name (`fulfilment_job_stalled`), and stamp `alerted_at` the same way so alerts fire once.
- [ ] Keep the sweep logic in a small pure/injectable function if trivially extractable (mirroring `expire-orders.ts`); do **not** restructure worker.ts beyond that — full worker test scaffolding is Plan 12.
- [ ] Unit-test the new sweep function (client injected, mirroring existing fulfilment tests): a 3 h-old `queued` row alerts once; a 10 min-old `queued` row does not; a terminal-status row never alerts.
- [ ] Run `npx vitest run src/server/fulfilment/` — expect PASS.
- [ ] Commit: `feat(worker): alert on fulfilment jobs stalled in non-terminal statuses (M-10)`

### Task 4 — regression tripwire (Opp-6)

- [ ] Create `scripts/queue-context-guard.test.ts`, mirroring `scripts/build-config.test.ts` (readFileSync tripwire + "do not weaken" comment): recursively read **every module reachable from a queue delivery**, not just `src/server/fulfilment/**`. Task 1 already identifies the second ALS-dependent caller, `src/server/print-assets/repository.ts` (`getAssetForFulfilment` → `getSupabaseAdmin`) — a guard scoped to `fulfilment/**` alone would pass while that file silently re-breaks deliveries (CodeRabbit finding). Define an explicit `QUEUE_REACHABLE_GLOBS` list in the test = `['src/server/fulfilment/**/*.ts', 'src/server/print-assets/repository.ts']` (plus any further queue-only module the Task-1 typecheck fan-out surfaces), exclude `*.test.ts`, and assert none contains `getSupabaseAdmin` or `getCloudflareContext`. Include a comment explaining C-2 (queue/scheduled handlers run outside the request ALS; only `supabaseFromEnv(env)` / injected clients are safe here) **and** a note that any new file entering the queue call-tree must be added to `QUEUE_REACHABLE_GLOBS`.
- [ ] Run `npx vitest run scripts/queue-context-guard.test.ts` — expect PASS (post-Task-1). Temporarily re-add a `getSupabaseAdmin` import to **both** a `fulfilment/**` file and `repository.ts` to confirm each FAILS, then revert.
- [ ] Add a scoped ESLint `no-restricted-imports` block for `files: ['src/server/fulfilment/**/*.ts', 'src/server/print-assets/repository.ts']` forbidding importing `getSupabaseAdmin`/`getCloudflareContext` from `@/lib/supabase` — this enforces the injected-client API at lint time on exactly the queue-reachable set, belt-and-braces with the tripwire test (which is the required deliverable; it runs in `npm test` + CI unconditionally).
- [ ] Commit: `test(fulfilment): tripwire against ALS-dependent imports in the queue path (Opp-6)`

## Database / migration work

None. (`alerted_at` already exists — added by `20260715120000_fulfilment_jobs_alerted_at.sql`.)

## External-system changes

None in this plan. The controlled queue rehearsal (preview deploy, real queue binding, sandbox Prodigi) is **Plan 05** and is this plan's completion gate for the "works at runtime" claim.

## Tests

- **Changed:** `process-job.test.ts` — mocks `supabaseFromEnv` (with `getSupabaseAdmin` throwing) so the suite fails if anyone reverts to the ALS path; repository tests updated for the injected client.
- **New:** stalled-job sweep unit tests; the tripwire guard test.
- **Regressions caught:** re-introduction of ALS-dependent client construction anywhere under `src/server/fulfilment/`; silent queue-error swallowing; sweep ignoring non-terminal statuses.
- **Simulated failure modes:** ALS-unavailable client construction (throwing mock); stalled `queued` row aging past 2 h.

## Verification

- **Local/unit:** `npm run lint && npm run typecheck && npm test` green; paste the `process-job.test.ts` run. Confirm the tripwire fails when sabotaged (describe the sabotage-and-revert check).
- **Preview/staging (runtime, from Plan 05):** `npm run preview:cf` with `FULFILMENT_QUEUE` bound, push one `FulfilmentJobMessage`, `wrangler tail` → expect successful processing (job → `fulfilment_submitted`/terminal, a sandbox `prodigi_orders` row) and **no** `getCloudflareContextSync` throw. `SELECT status, count(*) FROM fulfilment_jobs GROUP BY 1` on the preview DB shows no stranded `queued` rows.
- **Live:** nothing to mutate; production validation rides the first real print sale after Plan 05 signs off.

## Rollout / recovery

1. Land Tasks 1-4 in one PR (`fix:` — this should cut a release).
2. Do **not** announce prints as safe until Plan 05's rehearsal passes in preview.
3. **Rollback:** revert the PR — the previous behaviour is the known-broken-but-latent state, no worse than today. No data migration to unwind.
4. **Stop signals:** `fulfilment_queue_error` logs with `disposition: 'retry'` recurring for the same order in preview; any DLQ delivery during the rehearsal.
5. If a real print order arrives **before** this lands: the customer has paid but the job dead-lettered. **Do not hand-submit via `npm run prodigi`** — the CLI blocks live production order creation by design (AGENTS.md), and a manual submission would bypass the idempotency key, retry, and status-recovery that the queue path owns, risking a double-submit or an untracked Prodigi order. The recovery path is **queue-safe re-enqueue**: fix the job row to a re-enqueueable state and re-drive it through `enqueueProdigi()` → `FULFILMENT_QUEUE` → `process-job.ts` (the same path the webhook uses), or, until that recovery tooling exists (Plan 11 / Opp-5 reconcile-mode), **stop-and-escalate**: alert the operator from the DLQ handler and reconcile manually against Prodigi state before any resubmission. Link `docs/prodigi-cli.md` (for inspection only) in the PR description.

## Acceptance criteria

- [ ] `process-job.test.ts` fails on the pre-fix code and passes on the post-fix code (demonstrated in the PR by the ordered commits).
- [ ] No queue-reachable module (`src/server/fulfilment/**` **and** `src/server/print-assets/repository.ts`, plus any further module in `QUEUE_REACHABLE_GLOBS`) references `getSupabaseAdmin`/`getCloudflareContext`; the tripwire test + scoped ESLint rule enforce it.
- [ ] Queue errors produce a structured log line with order id + attempt; retries carry `delaySeconds`.
- [ ] A > 2 h `queued` job alerts exactly once through the existing alert machinery.
- [ ] Plan 05's preview rehearsal completes one job end-to-end through the real queue runtime.

## Dependencies

- **Plan 03 (M-16)** should land before or with this plan so the new alerts actually reach Sentry from worker contexts; the structured logs stand alone otherwise. This is the only **upstream** dependency.
- **Plan 05** (rehearsal) is this plan's runtime **exit gate**, not an upstream dependency — Plan 05 depends on Plan 02, not the reverse. Land 02's code first; 05 then validates it at runtime in preview. (This avoids the 02↔05 cycle the master index previously implied.)
- Plan 11 (Prodigi robustness) touches `process-job.ts` too — sequence after this plan to avoid conflicts.

## Risks / unresolved questions

- The exact `msg.retry({ delaySeconds })` option shape and `msg.attempts` availability must be confirmed against the installed `@cloudflare/workers-types` / current Queues docs at implementation time (the API has evolved; if per-message delay is unavailable in the installed types, use the consumer-level `retry_delay` in `wrangler.jsonc` instead and note the coarser granularity).
- Threading the client into `resolveSignedAssetUrl` may fan out to more callers than listed — let `npm run typecheck` enumerate them; if the fan-out exceeds ~10 call sites, stop and reconsider a narrower injection point rather than a sweeping refactor.
