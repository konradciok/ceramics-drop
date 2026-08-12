# Remediation 03 — Worker-scope Sentry + cron alerting (M-16 / M-15) — P0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` (§5 M-16, M-15; §12; §15.9). Evidence re-verified at HEAD `3da7ee0` on 2026-08-12.

**Goal:** Make the worker's own contexts (`queue()`, `scheduled()`, DLQ) able to actually deliver their alerts — today every `Sentry.captureMessage` there may be a silent no-op on a cold isolate, and the cron's most valuable signal (a paid PI on a still-`pending` order) is `console.warn`-only.

**Architecture:** `Sentry.init` runs only via Next instrumentation, which executes only on the OpenNext `fetch` path. The queue/scheduled/DLQ handlers in `worker.ts` import `@sentry/nextjs` and call `captureMessage` against a client that may never have been initialized in that isolate. Fix: initialize Sentry for the worker's non-fetch handlers using `@sentry/cloudflare` (same SDK major as the installed `@sentry/nextjs` 10.x), scoped so it does not double-instrument the fetch path. Then route the paid-on-pending cron signal through real alerting (studio email + Sentry), not just a log line.

**Tech stack:** `@sentry/cloudflare` (to be added), existing `src/lib/sentry-options.ts`, Resend studio-email helpers already used in `worker.ts`.

## Objective

C-2's "fails loudly" mitigation and every DLQ/failed-action/stalled-job alert depend on two channels: the DLQ email (silently skipped when `RESEND_API_KEY`/`STUDIO_NOTIFY_EMAIL` are unset — `worker.ts:145-153`) and worker-context Sentry (possibly a no-op — M-16). Both must be made reliable and their prerequisites verified in prod. Separately, a *missed* `payment_intent.succeeded` (money taken, order never fulfilled) currently surfaces only as `console.warn` from the cron (M-15).

## Findings covered

- **M-16** (MEDIUM) — no `Sentry.init` for the worker's own queue/scheduled/DLQ contexts. → PLANNED
- **M-15** (MEDIUM) — cron paid-on-pending is console-only; sweep failures are log-only (`abandoned_sweep_error` / `failed_action_sweep_error` structured logs, no alert), so a dead sweep still shows green in Cron Past Events. → PLANNED
- **§15.9 (partial)** — presence of `RESEND_API_KEY`, `STUDIO_NOTIFY_EMAIL`, `SENTRY_DSN` in prod secrets. → REQUIRES-VERIFICATION (read-only gate inside this plan; full secret sweep is Plan 04)

## Current-state evidence

All `VERIFIED` at HEAD `3da7ee0`:

- `VERIFIED` `worker.ts:8` — `import * as Sentry from '@sentry/nextjs';`; `captureMessage` calls at :110-113 (DLQ) and :289-292 (failed-action), both inside try/catch. **No `Sentry.init` anywhere in `worker.ts`.**
- `VERIFIED` — `Sentry.init` exists only in `src/sentry.server.config.ts:5`, `src/sentry.edge.config.ts:5`, `src/instrumentation-client.ts:5`, loaded via `src/instrumentation.ts:3-11` gated on `process.env.NEXT_RUNTIME` — i.e. only through the OpenNext fetch path, never for `queue()`/`scheduled()`.
- `VERIFIED` `package.json:61` — `@sentry/nextjs ^10.56.0`; `@sentry/cloudflare` is absent from dependencies and devDependencies.
- `VERIFIED` `worker.ts:145-153` — DLQ email silently skipped (structured `console.warn` `prodigi_dlq_email_skipped`) when `RESEND_API_KEY`/`STUDIO_NOTIFY_EMAIL` unset. (Contrast: the failed-action path at :325-327 throws on the same missing config.)
- `VERIFIED` `worker.ts:236` — the `warn` dep passed to `expireAbandonedOrders` is `console.warn` JSON only; the paid-on-pending branch inside `src/lib/expire-orders.ts:42-44` uses it. No Sentry/email.
- `VERIFIED` `worker.ts:76-88` — the `waitUntil`'d sweeps catch to structured `console.error` (`abandoned_sweep_error`, `failed_action_sweep_error`) — log-only; Cron Past Events shows the invocation green regardless.
- `VERIFIED` `wrangler.jsonc:56-70` — Workers Logs enabled at 100% sampling with `persist: true`, so structured logs ARE durable; the gap is alerting, not persistence.
- `INFERENCE` (audit, adversarially verified but not runtime-proven) — `captureMessage` without init is a no-op on a cold isolate; a warm isolate that previously served a fetch request may have an initialized client. Treat as "unreliable", which is enough to justify the fix.
- `NEEDS-RUNTIME-VERIFICATION` — presence of `SENTRY_DSN`, `RESEND_API_KEY`, `STUDIO_NOTIFY_EMAIL` in prod (`wrangler secret list`).

## Desired end state

- Sentry events captured from `queue()`, `scheduled()`, and the DLQ handler reliably arrive in Sentry regardless of isolate history, tagged so worker-context events are distinguishable (e.g. `runtime: worker-handler`).
- A `succeeded`/`processing` PI found on a still-`pending` order by the cron produces a **studio email + Sentry event at most once per order** — durably de-duplicated by a claim stamp so a persistently-pending order cannot emit an unbounded stream of alerts every 15 minutes (which would burn Resend + Sentry quota). See Task 2 for the claim mechanism.
- A sweep that itself throws produces a Sentry event.
- Prod presence of the three prerequisite secrets is confirmed and recorded.

## Scope

- `package.json` (add `@sentry/cloudflare`, pinned to the same major/minor family as `@sentry/nextjs`)
- `worker.ts` — Sentry wiring for its three non-fetch handlers + alert routing for paid-on-pending + sweep-failure capture
- `src/lib/expire-orders.ts` — extend the deps type with an `alert` callback (keep the pure-orchestrator pattern)
- `src/lib/sentry-options.ts` — reuse/extend shared options (release, environment) so worker events carry the same release tagging
- Tests: `src/lib/expire-orders` tests (exist or add), plus a unit test for the alert-once claim

## Out of scope

- Full `worker.ts` test scaffolding and `cancelIntent` matrix tests (Plan 12).
- The stalled-job sweep itself (Plan 02, Task 3 — this plan only guarantees its alert channel works).
- Client-side / fetch-path Sentry config (unchanged).
- Tracing (`wrangler.jsonc` `traces.enabled:false` stays as-is; §6.10 is backlog).

## Implementation steps

### Task 1 — worker-scope Sentry init (M-16)

- [ ] **Docs check first (required):** consult current `@sentry/cloudflare` docs (https://docs.sentry.io/platforms/javascript/guides/cloudflare/) for the supported pattern for a Worker with `fetch` + `queue` + `scheduled` handlers where the fetch path is *already* instrumented by `@sentry/nextjs` via OpenNext. Preferred shape: `Sentry.withSentry((env) => ({ dsn: env.SENTRY_DSN, ...sharedOptions }), handler)` wrapping the exported handler object — but the fetch double-instrumentation question decides between:
  - **Variant A** (if `withSentry` cleanly skips/tolerates an already-instrumented fetch): wrap the whole export.
  - **Variant B** (if it double-captures fetch errors): wrap only the `queue`/`scheduled` bodies with the SDK's scoped helpers (`Sentry.withIsolationScope` + explicit init per the Cloudflare guide's manual-usage section), leaving `fetch` untouched.
  Record which variant was chosen and why in the PR description. Do not guess — this is the one genuinely SDK-version-sensitive step.
- [ ] `npm install @sentry/cloudflare@^10` (align major with `@sentry/nextjs` 10.x; if peer ranges conflict, stop and re-evaluate rather than force).
- [ ] Implement the chosen variant in `worker.ts`, sourcing DSN from `env.SENTRY_DSN` (fail-soft: no DSN → no-op, never throw), reusing release/environment from `src/lib/sentry-options.ts`, and tagging `runtime: 'worker-handler'`.
- [ ] **Critical:** preserve the `DOQueueHandler`, `DOShardedTagCache`, `BucketCachePurge` re-exports from `.open-next/worker.js` — wrapping the default export must not drop them (deployment breaks otherwise, per AGENTS.md).
- [ ] `npm run build && npm run preview:cf` — confirm the worker boots and serves a page locally.
- [ ] Commit: `fix(worker): initialize Sentry for queue/scheduled/DLQ contexts (M-16)`

### Task 2 — alert on paid-on-pending + sweep death (M-15)

- [ ] Extend `ExpireOrdersDeps` in `src/lib/expire-orders.ts` with `alertPaidOnPending(orderId: string, piStatus: string): Promise<void>`; call it (in addition to the existing `warn`) on the paid-on-pending branch.
- [ ] **Failing test first:** unit-test `expireAbandonedOrders` (mirroring its existing test style) — a sweep encountering a `succeeded` PI on a `pending` order calls `alertPaidOnPending` exactly once and does **not** cancel that PI.
- [ ] In `worker.ts`, implement `alertPaidOnPending` using the same studio-alert machinery as the failed-action path (Resend email with an 8 s AbortController — the pattern at :155-156/:328-329 — plus `Sentry.captureMessage('paid_on_pending_order', { level: 'error', extra: { orderId, piStatus } })`).
- [ ] **Durable alert-once claim (required — resolves the objective's "at most once per order"):** before sending, atomically claim the alert with a CAS on a new nullable `orders.paid_on_pending_alerted_at timestamptz` column — `update orders set paid_on_pending_alerted_at = now() where id = $1 and paid_on_pending_alerted_at is null returning id`; only send when the claim returns a row (mirrors the existing `confirmation_email_sent_at` / `conversions_sent_at` / `alerted_at` claim pattern already used across the codebase). This is a tiny, backward-compatible additive migration (see Database / migration work) — the still-running old code simply never writes the column. Belt-and-braces: also pass a Resend `Idempotency-Key: paid-on-pending/<orderId>` and a Sentry `fingerprint: ['paid-on-pending', orderId]` so even a claim race collapses to one email/issue.
- [ ] Wrap each `waitUntil`'d sweep's `.catch` to also `Sentry.captureException(err)` (keeping the structured log).
- [ ] Run `npx vitest run src/lib/expire-orders*` — expect PASS.
- [ ] Commit: `fix(worker): alert (email+Sentry) on paid-on-pending orders and sweep failures (M-15)`

### Task 3 — prod prerequisites check (read-only external gate)

- [ ] Run `wrangler secret list` against the production Worker (read-only). Confirm `SENTRY_DSN`, `RESEND_API_KEY`, `STUDIO_NOTIFY_EMAIL` are present. Record the output (names only) in the PR/verification notes.
- [ ] If any is missing: **stop** and surface to the operator — setting a prod secret is a live mutation requiring explicit approval (and the DLQ email path is dark until it's set).

## Database / migration work

One tiny additive migration: `alter table orders add column if not exists paid_on_pending_alerted_at timestamptz;` (nullable, no default, no backfill). Backward-compatible — old code ignores it; the cron CAS-claims it to guarantee at-most-once alerting. Auto-applies on merge to `main` before the Workers build, same as every migration (write it additively so the still-running old worker is unaffected). Rollback: drop the column (the alert simply reverts to unbounded-but-logged, i.e. today's behaviour). Verify with `\d orders` / a `select` that the column exists post-merge.

## External-system changes

- `wrangler secret list` (read-only) — gate in Task 3.
- If `SENTRY_DSN` (or Resend vars) are missing in prod: setting them is a **gated live mutation**, listed here but requiring separate operator approval.
- After deploy, one **controlled verification event** (see Verification) confirms worker-context events arrive in Sentry.

## Tests

- **New:** `alertPaidOnPending` invocation test (fires once, does not cancel the PI); a **claim-stamp de-dup test** (first cron pass sends; a second pass over the same order — `paid_on_pending_alerted_at` already set — sends nothing); a smoke unit test that the worker's Sentry wrapper is fail-soft without a DSN (no throw when `SENTRY_DSN` undefined).
- **Regressions caught:** paid-on-pending regressing to log-only; sweep-death regressing to silent-green.
- **Simulated:** a `succeeded` PI on `pending` order; a sweep dep that throws.

## Verification

- **Local/unit:** `npm run lint && npm run typecheck && npm test` green (paste output).
- **Preview:** `npm run preview:cf`; trigger the scheduled handler locally (`wrangler dev --test-scheduled` / the preview's cron trigger endpoint `/__scheduled`) and confirm no boot errors; confirm the Sentry wrapper no-ops cleanly without a DSN.
- **Live read-only:** `wrangler secret list` output (Task 3).
- **Live post-deploy (small, bounded):** after the next production deploy, verify a worker-context event arrives in Sentry — preferred vehicle: Plan 05's rehearsal (its DLQ/alert checks); acceptable fallback: a temporary one-shot `captureMessage('worker_sentry_smoke')` behind a query of the scheduled handler, removed immediately after confirmation. Confirm in the Sentry UI (event with `runtime: worker-handler`).

## Rollout / recovery

1. Land Tasks 1-2; verify preview boots (the DO re-export check is the deployment risk).
2. Deploy rides the normal push-to-main flow; watch the Workers Build + first cron run in Cloudflare logs.
3. **Rollback:** revert the PR — pre-existing behaviour (silent captures) restores; nothing external to unwind.
4. **Stop signals:** worker boot failure in preview (missing DO re-exports); Sentry SDK errors in `wrangler tail`; any fetch-path double-reporting in Sentry (switch to Variant B).

## Acceptance criteria

- [ ] A Sentry event emitted from a worker (non-fetch) context is visible in the Sentry UI post-deploy (screenshot/event-id in verification notes).
- [ ] Paid-on-pending produces an email + Sentry event in a unit-tested path wired into the cron, and a **second** cron pass over the same still-pending order sends **nothing** (claim-stamp test proves at-most-once).
- [ ] Sweep-death produces a Sentry event.
- [ ] `wrangler secret list` confirms the three prerequisite secrets (or the gap is escalated, not silently accepted).
- [ ] Preview boots with the DO re-exports intact; all tests green.

## Dependencies

- None upstream. **Plan 02** and **Plan 05** depend on this plan's alert channels being real; land this before or alongside Plan 02, and strictly before Plan 05's rehearsal (the rehearsal validates these alerts).

## Risks / unresolved questions

- `@sentry/cloudflare` + `@sentry/nextjs` coexistence in one bundle (shared internals) is the main unknown — hence the mandatory Variant A/B docs check. If both variants prove problematic, the minimal fallback is a hand-rolled `captureWorkerMessage` posting to the Sentry envelope API with a 5 s timeout — noted as a fallback, not the default plan.
- Bundle-size impact of adding a second Sentry package to the worker bundle — check the OpenNext build output size delta; if it crosses a Workers size limit, use the fallback.
