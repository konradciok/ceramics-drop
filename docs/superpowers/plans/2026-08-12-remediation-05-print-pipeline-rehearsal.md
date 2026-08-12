# Remediation 05 — Print-pipeline production rehearsal (L-15 / L-22 / §15.2 / §15.8) — P0 exit gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` (§6.3, L-15, L-22, §15.2, §15.8). Runs **after** Plans 02 and 03 land. This plan mutates only preview/sandbox systems (plus Stripe **test mode**); it contains explicit gates and never touches live Prodigi or production customer data.

**Goal:** The entire print fulfilment chain — Stripe webhook → `webhook_events` ledger → Cloudflare Queue → `processJob` → Prodigi (sandbox) → callback — has **never executed in production**. Rehearse it end-to-end in a controlled environment before the first paying customer becomes the maiden run, and verify every alert channel actually fires.

**Architecture:** A preview Workers deployment with the real queue binding (`npm run preview:cf` binds `FULFILMENT_QUEUE`), `PRODIGI_ENV=sandbox`, Stripe test mode, and the fail-closed `/api/debug/fulfilment-status` endpoint enabled via `FULFILMENT_DEBUG_TOKEN` (preview-only by design). The existing destructive print-purchase E2E drives it; `wrangler tail` + DB reads + alert-channel checks confirm each stage.

**Tech stack:** `npm run preview:cf`, Playwright destructive print E2E, `wrangler tail`, Prodigi sandbox CLI (`npm run prodigi`), Supabase (preview target per env), Stripe test mode.

## Objective

Prove, with recorded evidence, that after Plan 02's fix: (1) a queue delivery processes in the **real queue runtime** (not the inline dev fallback), (2) the ledger + job rows advance to terminal states, (3) a sandbox Prodigi order is created and its callback lands, and (4) the failure path (DLQ + alerts) is loud — before any real print sale.

## Findings covered

- **L-15** (LOW, but the P0 gate) — webhook_events ledger + queue pipeline: zero production executions. → PLANNED (this rehearsal)
- **L-22** (LOW) — unexercised Prodigi contract assumptions (PLN `recipientCost`, 409-body idempotency, `InProduction` stage). → PLANNED (observed during rehearsal; discrepancies filed, not fixed here)
- **§15.2** — C-2 runtime verification (post-fix: expect success; also optionally demonstrate the pre-fix throw for the record if cheap). → PLANNED
- **§15.8** — end-to-end pipeline rehearsal incl. alert channels. → PLANNED
- **§6.11** (`in_production` stage reality) — **REQUIRES-VERIFICATION**: stays open until the rehearsal log records the actual sandbox callback stages. This plan *observes* it (does not pre-settle it); once the log captures the result, the master ledger is updated to the resulting status and Plan 11 Task 6 acts on it.

## Current-state evidence

- `VERIFIED` at HEAD `3da7ee0` — `wrangler.jsonc` binds `FULFILMENT_QUEUE` + consumers with DLQ; `worker.ts` queue consumer exists; `src/server/fulfilment/enqueue.ts:47-57` falls back to inline processing when the binding is absent (so only a *preview with the binding* exercises the real path).
- `VERIFIED` — `/api/debug/fulfilment-status` is fail-closed on `FULFILMENT_DEBUG_TOKEN` (404 unless set; per AGENTS.md the E2E passes `E2E_FULFILMENT_DEBUG_TOKEN`), and the destructive print E2E exists in `e2e/` (audit H-2 reference; exact spec name to be confirmed by glob at execution: `e2e/*print*`).
- `VERIFIED` — Prodigi sandbox tooling exists: `npm run prodigi` CLI (sandbox default), `npm run prodigi:contract-smoke`, `docs/prodigi-contract-smoke.md`.
- `CONFIRMED-LIVE` (audit) — `fulfilment_jobs` = 0, `prodigi_orders` = 0, `webhook_events` = 0 in prod: nothing has ever run.
- `NEEDS-RUNTIME-VERIFICATION` — everything this plan exists to verify.

## Desired end state

A recorded rehearsal log showing every pipeline stage green in preview, every alert channel proven to fire, and an explicit go/no-go statement for real print sales.

## Scope

- Preview deployment + its env/secrets (preview-scoped only)
- Stripe **test mode** objects (orders/PIs created and abandoned/refunded in test mode)
- Prodigi **sandbox** orders (created and cancelled)
- Preview-target Supabase rows (test orders); if preview shares the prod Supabase project, use clearly-marked test order rows and clean up after — record what was created
- New file: rehearsal log appended to `docs/audits/backend-audit-2026-08-12-verification.md` (or a sibling dated file). **This is a tracked, committed file — every evidence entry MUST be redacted first (see the redaction checklist below).** Raw, unredacted evidence (full tail dumps, signed URLs, screenshots with PII) stays **outside** the repo.

**Redaction checklist (apply to every logged evidence item before commit — especially since preview may share the production Supabase project):**
- Email addresses → mask (`a***@domain`).
- Customer / order identifiers, `payment_intent` ids, Prodigi order ids → truncate or pseudonymise (keep enough to correlate, not to identify — e.g. last 6 chars).
- Webhook payloads / `raw_json` → do not paste; summarise the relevant fields only.
- Signed print-asset URLs → strip `sig`/token query params (keep path + `exp` if needed).
- Tokens / secrets (`FULFILMENT_DEBUG_TOKEN`, keys) → never paste, not even partially.
- Screenshots → crop/blur any of the above before attaching.

## Out of scope

- **Remediation** code changes — if the rehearsal finds a *defect*, **stop, record, file**; fixes go through their owning plan, not a hotfix inside the rehearsal. **Exception:** the `PRODIGI_API_BASE_URL` preview override (Task 3) **is** an in-scope code change *this plan owns* — it is test/rehearsal harness, not a remediation fix — and it ships **with automated unit tests** (see Tests). It is the one deliberate code change here.
- Live-mode Stripe, live Prodigi, production customer rows.
- Load/perf testing.

## Implementation steps

### Task 1 — preview environment up

- [ ] Confirm Plans 02 and 03 are merged into the ref being rehearsed.
- [ ] `npm run preview:cf` (or a deployed preview worker) with: `FULFILMENT_QUEUE` bound, `PRODIGI_ENV=sandbox` + sandbox API key, Stripe **test-mode** keys + test-mode `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`, `FULFILMENT_DEBUG_TOKEN` set (preview only), Resend + `STUDIO_NOTIFY_EMAIL` pointed at the studio's own inbox, `SENTRY_DSN` set (a dev Sentry environment tag is fine).
- [ ] Record the exact env matrix in the log (names + prod/sandbox/test designation — no secret values).
- [ ] **GATE:** if preview shares the production Supabase project, get explicit operator acknowledgment before creating test order rows, and plan the cleanup list up front.

### Task 2 — happy path: one print purchase end-to-end

- [ ] Run the destructive print-purchase E2E against the preview (`PLAYWRIGHT_BASE_URL=<preview>`, `E2E_FULFILMENT_DEBUG_TOKEN` set; per memory, on Windows serve manually and set the base URL). Alternatively drive it manually: print PDP → cart → checkout (test card) → return page.
- [ ] While it runs: `wrangler tail` on the preview worker. Capture: webhook receipt, ledger claim, `enqueueProdigi` (must go through the **queue branch**, not inline — assert the absence of `fulfilment_inline_fallback` warns), queue delivery, `processJob` completion.
- [ ] Verify rows (SQL, read-only): `webhook_events` has the `payment_intent.succeeded` row `status='done'`; `fulfilment_jobs` row reached a submitted/terminal status (not stranded `queued`); `prodigi_orders` row exists with a sandbox `prodigi_order_id`.
- [ ] Verify via the debug endpoint: `GET /api/debug/fulfilment-status?payment_intent=<pi>` returns the advanced status.
- [ ] Verify in Prodigi sandbox (CLI `npm run prodigi -- order get <id>`): order exists; record its `outcome` and initial stage. **Do NOT cancel the sandbox order here.** Task 4's refund leg must exercise the *refund-triggered* cancel path, and `cancelPrintFulfilment` early-returns when `prodigi_status_stage === 'Cancelled'` — pre-cancelling now would let Task 4 pass vacuously. Leave this order active; cancellation is deferred to Task 5 cleanup (or drive Task 4 against a **second, dedicated** print order, created fresh — see Task 4).
- [ ] Record for L-22/§6.11: the actual callback stages received (does `InProduction` ever appear?), the `recipientCost` currency behaviour, and whether any 409-idempotency case arose. File discrepancies as findings for Plan 11 — do not fix here.

### Task 3 — failure path: alerts are loud

- [ ] **Define an *executable* injection mechanism up front — the drill must force a *retryable* failure deterministically, cannot depend on Plan 11 (which runs *after* this rehearsal), and needs a real knob that exists at rehearsal time.** An invalid sandbox key can surface as a **terminal** `ProdigiError` (`retryable: false`), which `decideMessageDisposition` **acks** (`src/server/fulfilment/queue-disposition.test.ts` documents `retryable: false → ack`) — proves nothing, drops the job with no DLQ hop.
  - **Prerequisite (in-scope code change + tests, per Out of scope / Tests):** check `src/server/prodigi/client.ts` `baseUrl(env)` — it currently switches sandbox/live by `PRODIGI_ENV` and has **no arbitrary-URL override**, so "point the base URL at a 5xx endpoint" is *not runnable as-is*. Add a small **preview-only** `PRODIGI_API_BASE_URL` override read in `baseUrl(env)`, **guarded so it is ignored in production** (never takes effect there), and ship it **with the three unit tests in the Tests section** (override applies off-prod, override rejected on prod, unset = unchanged). This is the executable knob; the prod-rejection test is its safety gate.
  - **Drill:** set `PRODIGI_API_BASE_URL` in the preview env to a 5xx/unroutable endpoint → the client's `fetch` catch maps the network error to `ProdigiError(…, null, true)` (retryable) → every delivery retries → DLQ. Do **not** rely on Plan 11's timeout (not merged at rehearsal time).
- [ ] **Before running the drill, assert the injected error is classified `'retry'`** — e.g. a one-off `decideMessageDisposition(<the injected error>) === 'retry'` check (unit or a `wrangler tail` observation of a retry, not an ack) — so the drill is known to exercise backoff→DLQ, not a silent ack.
- [ ] Run it: observe retries with backoff (Plan 02) in tail, then DLQ delivery.
- [ ] Confirm the DLQ handler fires: studio email received AND Sentry event visible (Plan 03's worker-context init — this is its live proof).
- [ ] Confirm the stalled-job sweep (Plan 02 Task 3): a job left in a non-terminal state > 2 h alerts. (Time-box: temporarily lowering the threshold via a preview-only env/edit is NOT allowed — instead backdate the test row's `updated_at` via SQL on the preview target, which keeps code untouched.)
- [ ] Restore the Prodigi base URL / sandbox key; re-drive or cancel the failed job; clean up rows.

### Task 4 — refund leg (joint with Plan 01, test mode)

- [ ] In Stripe **test mode** on the preview endpoint (its own test webhook endpoint with `charge.refunded` + `refund.failed` subscribed): refund the payment of a print order whose sandbox Prodigi order is **still active** (the Task 2 order kept active per Task 2, or a fresh second order created here). Confirm the order flips `refunded` and the **refund-triggered** print-fulfilment cancel path actually runs — assert the sandbox order was `Cancelled` *by this refund* (record its stage before = active, after = Cancelled), proving `cancelPrintFulfilment` did the work rather than early-returning on an already-cancelled order.
- [ ] Record as Plan 01's E2E evidence.

### Task 5 — go/no-go + cleanup

- [ ] Cleanup checklist executed (test orders annotated/removed per Task 1 plan; sandbox orders cancelled; preview-only secrets like `FULFILMENT_DEBUG_TOKEN` confirmed absent from prod — cross-check Plan 04 Task 6).
- [ ] Write the go/no-go statement for real print sales into the log, signed with date + evidence links — **all evidence redacted per the checklist in Task 1** before commit. **No-go criteria:** any stage silently failed, any alert channel dark, any stranded row.

## Database / migration work

None. SQL used is read-only except preview-target test-row cleanup/backdating, which is confined to rows this rehearsal created.

## External-system changes

| Operation | System | Mode | Gate |
|---|---|---|---|
| Preview deploy + env | Cloudflare (preview worker) | Mutation (preview-scoped) | Standard |
| Test purchase + refund | Stripe **test mode** | Mutation (test) | Standard |
| Sandbox order create/cancel | Prodigi **sandbox** | Mutation (sandbox) | Standard |
| Test rows on shared Supabase (if preview shares prod project) | Supabase | Mutation (test rows) | **Explicit operator acknowledgment** |
| Anything live-mode / production | — | — | **FORBIDDEN in this plan** |

## Tests

The destructive E2E already exists and is the rehearsal driver; if it proves unrunnable on the executing machine, the manual drive-through is acceptable — but every assertion above must still be recorded with evidence.

**Required automated unit tests for the one code change (the `PRODIGI_API_BASE_URL` override in `src/server/prodigi/client.ts` `baseUrl(env)`):**
- when `PRODIGI_API_BASE_URL` is set **and** a non-production marker is present → `baseUrl(env)` returns the override;
- when `PRODIGI_API_BASE_URL` is set **but the host/env is production** → the override is **ignored** (returns the normal sandbox/live URL) — proving the override can never redirect production Prodigi traffic;
- when `PRODIGI_API_BASE_URL` is unset → unchanged behaviour (sandbox/live by `PRODIGI_ENV`).
These land in the same commit as the override; the production-rejection test is the safety gate that makes the harness acceptable.

## Verification

This plan is itself the verification stage for Plans 02/03 and the pipeline. Completion claims require the rehearsal log containing: tail excerpts for each stage, row-state SQL outputs, the received alert email screenshot/id, the Sentry event id, the Prodigi sandbox order id + cancellation, and the go/no-go statement.

## Rollout / recovery

- Nothing deploys to prod from this plan. The "rollout" is the go/no-go decision for real print sales.
- **Stop signals:** any silent failure (a stage that neither succeeded nor alerted) is an automatic no-go and files a new finding.

## Acceptance criteria

- [ ] The `PRODIGI_API_BASE_URL` override + its three unit tests (off-prod applies, **prod rejects**, unset unchanged) are merged and green — the executable failure-injection knob is in place and provably cannot affect production.
- [ ] One print order processed end-to-end through the **real queue runtime** in preview, with all rows terminal and a sandbox Prodigi order created.
- [ ] DLQ email + worker-context Sentry event both observed (screenshots/ids in the log).
- [ ] Stalled-job alert observed via the backdated-row test.
- [ ] Refund leg observed in test mode (order → `refunded`, print cancel path invoked).
- [ ] `in_production`/contract observations recorded for Plan 11; L-22 assumptions annotated with observed reality.
- [ ] Cleanup complete; go/no-go statement written.

## Dependencies

- **Plan 02** (queue context fix) and **Plan 03** (worker Sentry) must be merged first.
- **Plan 01** Task 5 (test-mode refund subscription on the preview endpoint) for Task 4.
- Plan 04 Task 6 (prod secret sweep) cross-checks `FULFILMENT_DEBUG_TOKEN` absence in prod.

## Risks / unresolved questions

- Whether the preview environment has (or should have) a separate Supabase target — per project memory, local envs point at the production project; the Task 1 gate handles this, but a dedicated preview branch DB (Supabase branching) is worth considering if test-row hygiene proves messy.
- `wrangler dev`/preview queue semantics may differ subtly from deployed queues (local queue simulator vs real). If `npm run preview:cf` proves insufficiently faithful, escalate to a **deployed** preview worker with real queues — still non-production, still in scope.
- Time-boxing: the stalled-sweep check depends on cron firing in preview; if the preview runtime lacks cron, trigger `scheduled()` manually (`/__scheduled` test endpoint or `wrangler dev --test-scheduled`).
