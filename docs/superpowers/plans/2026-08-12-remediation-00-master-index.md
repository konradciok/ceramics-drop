# Backend Audit Remediation — Master Plan Index (2026-08-12)

> **For agentic workers:** this is the index. Each remediation plan below is a standalone, independently-executable file carrying the full `superpowers:writing-plans` structure (Objective / Findings / Current-state evidence / Scope / Out-of-scope / Steps / DB work / External changes / Tests / Verification / Rollout / Acceptance / Dependencies / Risks). Execute plans in the order given, respecting the dependency notes. Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` per plan.

**Source audit:** `docs/audits/backend-audit-2026-08-12.md` (1 CRITICAL · 1 HIGH · 29 MEDIUM · 44 LOW · 15 incomplete features · 23 opportunities).

**Planning baseline:** all evidence re-verified read-only against **HEAD `3da7ee0`** (`docs/context-refresh`) on 2026-08-12 by four inspection passes (Stripe/webhook, queue/worker/Prodigi, Supabase/data, auth/admin/misc). **No finding was found already-resolved** — every **non-refuted** finding remains applicable or requires verification at HEAD (H-2 is `[REFUTED]` in the audit: not an active bypass, only a residual hardening item — see Plan 09). Four audit **line-number/scope corrections** surfaced and are carried into the owning plans (see "Audit corrections" below). This is a **planning stage only** — no code, migration, config, or data was changed; the only repository changes are these plan files.

---

## Execution order & plan roster

**Status as of 2026-08-14:** 8 of 14 plans merged to `main` (01, 02, 03, 05, 06, 07, 08, 11). Plan 04 is all but done (Cloudflare-side gates, H-4, M-25, L-25 T4b and L-40 closed — the last three operator-verified against the dashboards on 2026-08-14; only the H-2 preview probe remains, deliberately held for a manual operator run). Plans 09, 10, 12, 13, 14 have not been started — no branch or PR exists for any of them.

| # | Plan file | Status | Priority | Findings covered | Live/external gate? | Depends on |
|---|---|---|---|---|---|---|
| 00 | `…-00-master-index.md` (this) | — | — | ledger | — | — |
| 04 | `…-04-live-config-verification.md` | 🟡 **PARTIAL** — PR [#242](https://github.com/konradciok/ceramics-drop/pull/242) (Cloudflare gates: M-6, L-25 T4a, §15.9) + H-4, M-25, L-25 T4b, L-40 closed 2026-08-14 (Sentry + operator dashboard pass, see verification log). Open: H-2 (T5) only | **P0** (read-only, run first) | H-4 ✅, M-6* ✅, M-25 ✅, L-25 ✅, H-2* ⬜, L-40 ✅, §15.1/.9 ✅ | Read-only dashboard/CLI access | none |
| 01 | `…-01-stripe-refund-reconciliation.md` | ✅ **MERGED** PR [#245](https://github.com/konradciok/ceramics-drop/pull/245) (2026-08-13) | **P0** | C-1, H-3, M-28, Opp-2, Opp-3 | **YES** — Stripe `enabled_events` + prod backfill — **executed live**, both gates run (see verification log) | none (folds §15.1) |
| 02 | `…-02-queue-context-fix.md` | ✅ **MERGED** PR [#241](https://github.com/konradciok/ceramics-drop/pull/241) (2026-08-12) + PR [#244](https://github.com/konradciok/ceramics-drop/pull/244) (M-10 combined w/ Plan 03) | **P0** | C-2, M-10, M-23, L-21, Opp-6 | Preview rehearsal is the exit gate — **passed** (Plan 05 rehearsal, zero `fulfilment_inline_fallback` warns) | 03 (alerts) — Plan 05 is 02's runtime **exit gate**, not an upstream dependency |
| 03 | `…-03-worker-sentry-cron-alerting.md` | ✅ **MERGED** PR [#243](https://github.com/konradciok/ceramics-drop/pull/243) (M-16) + PR [#244](https://github.com/konradciok/ceramics-drop/pull/244) (M-15) (2026-08-13) | **P0** | M-16, M-15, §15.9(partial) | `wrangler secret list` (read) — done, all present; DSN was already set | none |
| 05 | `…-05-print-pipeline-rehearsal.md` | ✅ **MERGED** PR [#246](https://github.com/konradciok/ceramics-drop/pull/246) (2026-08-13) | **P0 exit gate** | L-15, L-22, §15.2, §15.8, §6.11(observe) | **YES** — preview deploy + Stripe test-mode + Prodigi sandbox — **executed**; conditional GO cleared by Plan 11 | 01(Task5), 02, 03 |
| 06 | `…-06-stripe-webhook-hardening.md` | ✅ **MERGED** PR [#248](https://github.com/konradciok/ceramics-drop/pull/248) (2026-08-13) | **P1** | H-1, M-5, M-21, M-22, M-27, L-4, L-5, L-6, L-7 | none (preview validation) | 01 (same files) |
| 07 | `…-07-supabase-hardening.md` | ✅ **MERGED** PR [#249](https://github.com/konradciok/ceramics-drop/pull/249) (2026-08-14) | **P1** | M-2, M-3, M-4, L-10, L-12, L-13 | **YES** — migration auto-applies to prod on merge — **executed**, first pgTAP CI run passed | Task 0 live reads |
| 08 | `…-08-env-completeness.md` | ✅ **MERGED** PR [#250](https://github.com/konradciok/ceramics-drop/pull/250) (2026-08-14) | **P1** | M-17, Opp-12(env half) | none | none |
| 09 | `…-09-admin-auth-hardening.md` | ⬜ **NOT STARTED** | **P2** | M-7, M-6, H-2(residual), M-1, L-26, L-27, L-29, L-30 | Sequencing gate on `ADMIN_ALLOWED_EMAILS` | 04(Task 2) ✅ done, 04(Task 5 — H-2 preview probe) ⬜ still open, 03 ✅ done — **partially unblocked**; Task 5 doesn't gate 09's own code (H-2 hardening is defense-in-depth either way), but run it first for a clean input |
| 10 | `…-10-global-rate-limiting.md` | ⬜ **NOT STARTED** | **P2** | M-8, M-9, §6.1, Opp-1 | Binding deploy (possible beta toggle) | none |
| 11 | `…-11-prodigi-robustness.md` | ✅ **MERGED** PR [#247](https://github.com/konradciok/ceramics-drop/pull/247) (2026-08-13) | **P2** | M-11, M-12, M-14, M-26, L-19, L-24, §6.11(resolve) | Prodigi sandbox (standard) — **executed**; M-12 also proven live on prod post-merge | 02, 05, 03 |
| 12 | `…-12-oversell-worker-test-coverage.md` | ⬜ **NOT STARTED** | **P2** | M-18, M-19, Opp-8, Opp-12(extraction half) | none | 02 ✅, 03 ✅, 07(soft) ✅ — **unblocked, ready to start** |
| 13 | `…-13-inpost-webhook-hardening.md` | ⬜ **NOT STARTED** | **P2** | M-13, L-34, L-35 | **YES** — `INPOST_WEBHOOK_TOKEN` rotation + panel re-register | none |
| 14 | `…-14-platform-hygiene.md` | ⬜ **NOT STARTED** | **P2/P3** | L-33, L-32, M-24, L-14, Opp-11/13/14 | Possible R2 bucket (adopt branch), gated | none |

`*` M-6 and H-2 are split: **verification** of severity/empirics is Plan 04 (M-6 done, stays LOW; H-2 probe still open); **code hardening** is Plan 09 (not started).

### Recommended sequencing

1. ~~**First wave (parallel):** Plan 04 (read-only verification — feeds several downstream plans), Plan 08 (env, trivial, independent), Plan 03 (worker Sentry — prerequisite for 02/05 alerts).~~ **DONE** — Plan 03 and Plan 08 merged; Plan 04 all but done (Cloudflare gates + H-4 + M-25 + L-25 T4b + L-40 closed; only the H-2 preview probe remains).
2. ~~**P0 money/fulfilment core:** Plan 01 (refunds) → Plan 02 (queue fix) → Plan 05 (rehearsal, gates prints).~~ **DONE** — all three merged; Plan 05's conditional GO was cleared by Plan 11 (F-1 fix). Real print sales unblocked.
3. ~~**P1 hardening:** Plan 06 (after 01 — shared files), Plan 07 (migration; independent), Plan 08 (any time).~~ **DONE** — Plans 06, 07, 08 all merged.
4. **P2 (current front):** Plans 09 (after 04, 03 — **unblocked**), 10, 11 (after 02/05 — **done**, merged), 12 (after 02/03 — **unblocked**), 13, 14 — largely parallel; watch `worker.ts` merge contention between 09/10/12/13/14 (02/03/11 already landed there). **Not yet started: 09, 10, 12, 13, 14.**

### Live/external execution gates (require explicit operator approval at implementation time)

- **Plan 01:** add `charge.refunded`+`refund.failed` to the live Stripe endpoint; backfill order `8be30881…`/piece `s15`. — ✅ **executed** 2026-08-13 (operator-approved).
- **Plan 07:** the hardening migration auto-applies to prod on merge to `main` (~1 min, before the Workers build) — the merge **is** the mutation; write backward-compatible (the plan verifies this). — ✅ **executed** 2026-08-14 (merge landed, first pgTAP CI run passed).
- **Plan 13:** rotate `INPOST_WEBHOOK_TOKEN` + re-register the panel URL. — ⬜ **not started**.
- **Plan 03/04/09:** possible prod secret sets / Access-policy tightening if the read-only checks find gaps. — Plan 03: ✅ done, all required secrets already present, no mutation needed. Plan 04: ✅ M-6 checked, stayed LOW, no mutation needed; remaining Plan 04 tasks are read-only and unlikely to need one. Plan 09: ⬜ not started — will need `ADMIN_ALLOWED_EMAILS` set in the same rollout as its fail-closed code change (sequencing gate, see roster).
- **Plan 05:** preview/sandbox/test-mode mutations only — never production-live. — ✅ **executed** 2026-08-13, full cleanup verified (preview worker/queues deleted, prod domains intact).
- **Plan 14:** R2 bucket creation only if the M-24 "adopt" branch is chosen. — ⬜ **not started**.

---

## Finding-status ledger

Every finding ID from the audit, with its status. Original triage statuses: **PLANNED** (assigned to a remediation plan), **REQUIRES-VERIFICATION** (a read-only/runtime check gates the fix or its severity — owned by a plan), **DEFERRED** (consciously out of remediation scope, rationale given), **STALE/ALREADY-RESOLVED** (none). No finding is left without a status. **As of 2026-08-14**, a fifth status is layered on top as plans land: **✅ MERGED** (the owning plan's PR is merged to `main`) — superseding a prior PLANNED or REQUIRES-VERIFICATION status wherever it appears below.

### Critical & High (§4)

| ID | Severity (adjudicated) | Status | Plan |
|---|---|---|---|
| C-1 | CRITICAL | ✅ **MERGED** PR #245 | 01 |
| C-2 | HIGH | ✅ **MERGED** PR #241, runtime-verified in Plan 05 rehearsal | 02 (runtime verify: 05) |
| H-1 | MEDIUM | ✅ **MERGED** PR #248 | 06 |
| H-2 | LOW (refuted) | REQUIRES-VERIFICATION → PLANNED (residual) — **still open**: Plan 04 Task 5 (preview probe) not yet run, Plan 09 not started | 04 (probe) + 09 (normalize) |
| H-3 | MEDIUM | ✅ **MERGED** PR #245 (`refund.failed` leg landed; full event-model migration DEFERRED) | 01 |
| H-4 | MEDIUM | **CLOSED** — resolved-as-benign, verified 2026-08-14 (local dev host, no prod impact); see `backend-audit-2026-08-12-verification.md` | 04 |

### Medium (§5)

| ID | Status | Plan / rationale |
|---|---|---|
| M-1 | PLANNED — not started | 09 (verified-email guard) |
| M-2 | ✅ **MERGED** PR #249 | 07 |
| M-3 | ✅ **MERGED** PR #249 (dynamic policy-drop `DO $$` block, not the live policy-name read — see Plan 07's Ruling 1; tooling gap, provably correct regardless) | 07 |
| M-4 | ✅ **MERGED** PR #249 (both DB CHECKs + two-tier app-layer guard) | 07 |
| M-5 | ✅ **MERGED** PR #248 | 06 |
| M-6 | ✅ **VERIFIED** (04, PR #242 — Access policy narrow, stays LOW) → PLANNED (09, **not started**) | 04 + 09 |
| M-7 | PLANNED — not started | 09 |
| M-8 | PLANNED — not started | 10 |
| M-9 | PLANNED — not started | 10 |
| M-10 | ✅ **MERGED** PR #244 | 02 |
| M-11 | ✅ **MERGED** PR #247 | 11 |
| M-12 | ✅ **MERGED** PR #247, **live-proven on prod** post-merge (reconciliation sweep advanced a frozen rehearsal order to `Complete`) | 11 |
| M-13 | PLANNED — not started | 13 |
| M-14 | ✅ **MERGED** PR #247 | 11 |
| M-15 | ✅ **MERGED** PR #244 | 03 |
| M-16 | ✅ **MERGED** PR #243, live-proven (worker-context Sentry issues from queue/scheduled contexts during Plan 05 rehearsal) | 03 |
| M-17 | ✅ **MERGED** PR #250 | 08 |
| M-18 | PLANNED — not started | 12 |
| M-19 | PLANNED (scope corrected — see corrections) — not started | 12 |
| M-20 | DEFERRED — ack-fast/queue rearchitecture of the webhook; risk bounded by Stripe's 3-day retry + Plan 06's error-handling fixes at current volume. Revisit on latency alarms/volume. | 06 (noted) |
| M-21 | ✅ **MERGED** PR #248 | 06 |
| M-22 | ✅ **MERGED** PR #248 | 06 |
| M-23 | ✅ **MERGED** PR #241 | 02 |
| M-24 | PLANNED (adopt-or-remove spike) — not started | 14 |
| M-25 | ✅ **CLOSED** 2026-08-14 — operator-verified clean branch (dashboard read, no rotation triggered); see verification log | 04 |
| M-26 | ✅ **MERGED** PR #247 | 11 |
| M-27 | ✅ **MERGED** PR #248 | 06 |
| M-28 | ✅ **MERGED** PR #245 | 01 |

### Low (§5) — detailed in the audit body

| ID | Status | Plan / rationale |
|---|---|---|
| L-1 | DEFERRED — validateCart DB-amplification; partly mitigated by Plan 10's checkout limit; cheap guard-reorder can ride a future checkout change. | 10 (noted) |
| L-4 | ✅ **MERGED** PR #248 | 06 |
| L-5 | ✅ **MERGED** PR #248 (alert only; invoice retry/backfill stays deferred) | 06 |
| L-6 | ✅ **MERGED** PR #248 | 06 |
| L-7 | ✅ **MERGED** PR #248 | 06 |
| L-8 | DEFERRED — residual lock-ordering window; documented (not fixed) by Plan 12's pgTAP. | 12 (noted, not started) |
| L-9 | DEFERRED — CMS audit-row-outside-txn; editorial-surface-only, non-money-path; in-repo fix pattern exists for a future CMS change. | 07 (noted) |
| L-10 | ✅ **MERGED** PR #249 | 07 |
| L-11 | DEFERRED — `FOR SHARE` phantom-INSERT window; admin-only, theoretical; revisit if variants become user-writable. | 07 (noted) |
| L-12 | ✅ **MERGED** PR #249 | 07 |
| L-13 | ✅ **MERGED** PR #249 (target column corrected — see corrections) | 07 |
| L-14 | PLANNED — not started | 14 |
| L-15 | ✅ **CLOSED** — rehearsed in preview (Plan 05, PR #246), Plan 05's blocking condition cleared by Plan 11 (PR #247); real print sales unblocked | 05 |
| L-16 | DEFERRED — attemptId oracle infeasible at 122-bit entropy (audit's own assessment). | 09 (noted, not started) |
| L-17 | DEFERRED — intentional FK gaps; docs-only clarification, no behaviour change. | 07 (noted) |
| L-18 | DEFERRED — leaked-password protection off; moot while OAuth-only (per audit). Revisit before enabling email/password. | backlog |
| L-19 | ✅ **MERGED** PR #247 | 11 |
| L-20 | DEFERRED — USD/CAD dead-but-valid CHECK values by design. | backlog |
| L-21 | ✅ **MERGED** PR #241 | 02 |
| L-22 | ✅ **CLOSED** (informational) — contract assumptions observed and documented in `types.ts`/`docs/orders-cli.md` (merchant-currency `recipientCost`); no code fix needed | 05 (input) → 11, PR #247 |
| L-23 | DEFERRED — `PRINT_ASSET_TOKEN_SECRET` key-versioned rotation; audit §13-extended item, not a defect today. | 11 (noted) → backlog |
| L-24 | ✅ **MERGED** PR #247 | 11 |
| L-25 | ✅ **CLOSED** — direct-exposure check (T4a) via PR #242 (r2.dev disabled, no custom domain); S3-token-scope check (T4b) operator-verified clean 2026-08-14 | 04 |
| L-26 | PLANNED — not started | 09 |
| L-27 | PLANNED — not started | 09 |
| L-29 | PLANNED — not started | 09 |
| L-30 | PLANNED (bonus: the "gitignored/never-committed" comment is factually false — file is tracked; see corrections) — not started | 09 |
| L-31 | DEFERRED — `/api/returns` capability token assessed deliberate + well-hardened (audit). | 09 (noted) |
| L-32 | PLANNED — not started | 14 |
| L-33 | PLANNED (headers half; CSP-enforce cutover explicitly out of scope) — not started | 14 |
| L-34 | PLANNED — not started | 13 |
| L-35 | PLANNED — not started | 13 |
| L-38 | DEFERRED — newsletter scanner auto-confirm; §6.12 product decision ("ship when scanner-confirms show up in practice"), already accepted-in-code. | backlog |
| L-39 | ✅ **CLOSED** — `debug/fulfilment-status` safe only by never setting its token in prod; Plan 04 Task 6 (PR #242) confirmed `FULFILMENT_DEBUG_TOKEN` absent in prod. | 04 |
| L-40 | ✅ **CLOSED** 2026-08-14 — price-parity SQL operator-verified clean (no charge-vs-display mismatch); see verification log | 04 (Task 7) |

**Low IDs not individually enumerated in the audit body** (L-2, L-3, L-28, L-36, L-37): the audit compresses these into range notation ("L-32…L-40") and references a "master ledger §C" not present in the working tree. → **DEFERRED to backlog**, flagged for the operator to retrieve from the audit's full ledger before closing the audit. Not blockers for any P0–P2 remediation.

### Incomplete/partial features (§6)

| # | Feature | Status | Plan / rationale |
|---|---|---|---|
| 1 | Global (WAF) rate limiting | PLANNED — not started | 10 |
| 2 | Refund lifecycle (webhook leg) | ✅ **MERGED** PR #245 | 01 |
| 3 | Ledger + Prodigi pipeline in prod | ✅ **CLOSED** — rehearsed end-to-end in preview (Plan 05) and confirmed live on prod post-merge (M-12 sweep proof, Plan 11) | 05 |
| 4 | Quantity stock reservation | DEFERRED — wire only when print inventory limits are needed (not a defect; prints are unlimited-by-design). | backlog |
| 5 | Per-product EUR/GBP + sale prices | REQUIRES-VERIFICATION (parity, **still open** — Plan 04 Task 7) → DEFERRED (wire-or-remove) | 04 (verify) + backlog |
| 6 | `products.slug` pretty URLs | DEFERRED — dead admin capability; build routing or hide the field. | backlog |
| 7 | `pod_variants` consumed catalogue | DEFERRED — document as verification-only or consume. | backlog |
| 8 | Worker-scope Sentry | ✅ **MERGED** PR #243, live-proven in Plan 05 rehearsal | 03 |
| 9 | CSP enforce + API security headers | PLANNED (headers, not started) / DEFERRED (CSP-enforce cutover — pending deploy op) | 14 |
| 10 | Workers traces (`enabled:false`) | DEFERRED — enable or remove; observability nicety. | backlog |
| 11 | `in_production` fulfilment stage | ✅ **RESOLVED** — dead `InProduction` mapping removed, confirmed against live Prodigi v4 stage vocabulary (`Draft`/`InProgress`/`Complete`) | 05 (observe) + 11 (resolve), PR #247 |
| 12 | Newsletter human-confirmation | DEFERRED — product decision (L-38). | backlog |
| 13 | Abandoned-cart recovery | DEFERRED — product/consent decision (automation disabled per prior memory). | backlog |

### Feature-development opportunities (§13) — remediation-relevant only

Grounded opportunities that **close or guard a specific finding** are folded into plans; independent growth features are excluded from remediation per scope.

| Opp | Status | Plan |
|---|---|---|
| Opp-1 (native rate-limit binding) | PLANNED — not started | 10 |
| Opp-2 (webhook-config drift guard) | ✅ **MERGED** PR #245 | 01 |
| Opp-3 (refund reconciliation sweep) | ✅ **MERGED** PR #245 | 01 |
| Opp-4 (cron Prodigi reconciliation) | ✅ **MERGED** PR #247 | 11 |
| Opp-5 (print reconcile-mode CLI) | DEFERRED — cron sweep (11) covers the automated case; add CLI only if DLQ manual recovery proves clumsy. | 11 (noted) |
| Opp-6 (queue-context lint/test guard) | ✅ **MERGED** PR #241 | 02 |
| Opp-7 (RPC surface hardening migration) | ✅ **MERGED** PR #249 | 07 |
| Opp-8 (pgTAP CI for reserve_pieces) | PLANNED — not started | 12 |
| Opp-9 (authenticated-user RLS on orders) | DEFERRED — defense-in-depth, costs nothing but not guarding an active defect. | backlog |
| Opp-10 (alert on charge.dispute.created) | ✅ **MERGED** PR #248 | 06 (L-6) |
| Opp-11 (retention/pruning cron) | PLANNED — not started | 14 (L-14) |
| Opp-12 (env test + cancelIntent matrix) | 🟡 **PARTIAL** — env half ✅ MERGED PR #250; cancelIntent half not started | 08 (env) + 12 (cancelIntent) |
| Opp-13 (cache the merchant feeds) | PLANNED — not started | 14 (L-32) |
| Opp-14 (security-header block in worker) | PLANNED — not started | 14 (L-33) |
| Opp-15 (shorten TTL + redact asset URLs) | ✅ **MERGED** PR #247 | 11 (M-14) |
| Opp-16…23 (extended ledger: HMAC rotation, status-vocabulary single-source, composite indexes, Resend svix-id dedup, per-market parity, …) | DEFERRED — partial coverage lands opportunistically (status vocab → 07 L-13, merged; parity → 04 L-40, verified clean 2026-08-14; svix-id → adjacent to M-27, merged); the rest is backlog. | backlog |

### Verification gaps (§15) — ownership

| § | Gap | Owner | Status |
|---|---|---|---|
| 15.1 | Stripe v2 Event Destinations | 01 (Task 5 pre-check) | ✅ CLOSED — folded into Plan 01 PR #245 |
| 15.2 | C-2 runtime throw (post-fix: success) | 02 → 05 | ✅ CLOSED — verified in Plan 05 rehearsal (zero inline-fallback warns) |
| 15.3 | H-2 admin-gate variant probes | 04 (Task 5) | ⬜ OPEN — not yet run |
| 15.4 | H-4 admin-editor error host | 04 (Task 1) | ✅ CLOSED 2026-08-14, resolved-as-benign |
| 15.5 | M-6 Access-policy breadth + allowlist presence | 04 (Task 2) | ✅ CLOSED — PR #242, stays LOW |
| 15.6 | M-25 Supabase key format | 04 (Task 3) | ✅ CLOSED 2026-08-14 — operator-verified clean |
| 15.7 | L-25 R2 bucket posture | 04 (Task 4) | ✅ CLOSED — direct-exposure (T4a) PR #242; token scope (T4b) operator-verified 2026-08-14 |
| 15.8 | Whole pipeline rehearsal + alert channels | 05 | ✅ CLOSED — PR #246, cleared by Plan 11 PR #247 |
| 15.9 | Prod secret-name presence | 04 (Task 6) + 03 (Task 3) | ✅ CLOSED — PR #242 |

---

## Audit corrections carried into the plans

Read-only inspection at HEAD `3da7ee0` confirmed every finding but corrected four details — folded into the owning plans so implementers work from truth:

1. **M-19 scope** — `reserve_pieces` is **not** wholly untested: `supabase/tests/private-sale.sql:119-124` holds one regression assertion. The real gap is its *hardening invariants* (sorted-lock, missing-id folding, idempotent retry, showroom predicate, expired takeover). → Plan 12.
2. **L-13 target** — `prodigi_orders` has **no `status` column**; the free-text nullable column is `prodigi_status_stage` (`20260626120002:22`). → Plan 07.
3. **M-14 helper location** — `redactSignedPrintAssetUrl` lives in `src/lib/print-asset-smoke.ts:23`, not `print-assets.ts`, and is unused by `callbacks.ts`. → Plan 11.
4. **M-4 line numbers** — the price columns are `catalog_shadow.sql:30-35` (not 36-41); substance exact. → Plan 07.

## NEW FINDING (surfaced during planning — recorded, not fixed)

- **NF-1 · LOW · `[CONFIRMED-CODE]`** — `src/lib/admin/clients.ts:1-9` documents the file as *"LOCAL-ONLY … Never committed/deployed (gitignored via .git/info/exclude)"*, but `git ls-files` shows the file **is tracked** and `.git/info/exclude` contains only `.claude/*`. The misleading comment could lead an operator to believe prod-repointing `ADMIN_*` overrides can never reach a deployed context. This is the documentation half of **L-30** and is handled in Plan 09 Task 4 (truthful comment + prod-override warning) — logged here for traceability; no separate fix.

---

## Counts

**Original triage (2026-08-12):**

- **PLANNED:** 47 findings — C-1, C-2, H-1, H-3(partial), M-1, M-2, M-3, M-4, M-5, M-7, M-8, M-9, M-10, M-11, M-12, M-13, M-14, M-15, M-16, M-17, M-18, M-19, M-21, M-22, M-23, M-24, M-26, M-27, M-28, L-4, L-5, L-6, L-7, L-10, L-12, L-13, L-14, L-19, L-24, L-26, L-27, L-29, L-30, L-32, L-33, L-34, L-35.
- **REQUIRES-VERIFICATION:** 11 — H-2, H-4, M-6, M-25, L-15, L-22, L-25, L-39, L-40, §6.3, §6.11.
- **DEFERRED (with rationale):** 19 detailed + the undetailed-range set.
- **NEW FINDINGS:** 1 (NF-1, LOW — folded into Plan 09/L-30).

**Development status as of 2026-08-14** (superseding the counts above — see the roster and per-severity ledgers for the item-by-item breakdown):

- **MERGED:** 30 of the 47 originally-PLANNED findings, across Plans 01, 02, 03, 05, 06, 07, 08, 11 (all 8 merged plans) — C-1, C-2, H-1, H-3, M-2, M-3, M-4, M-5, M-10, M-11, M-12, M-14, M-15, M-16, M-17, M-21, M-22, M-23, M-26, M-27, M-28, L-4, L-5, L-6, L-7, L-10, L-12, L-13, L-19, L-24. Plus 9 of the original 11 REQUIRES-VERIFICATION items settled and closed: H-4 (resolved-as-benign), M-6 (verified, stays LOW, its code-hardening half re-filed under Plan 09), L-15 (rehearsed), L-22 (documented, no fix needed), L-39 (confirmed absent in prod), §6.11 (dead stage mapping removed), and M-25 / L-25 / L-40 (operator dashboard pass 2026-08-14, all clean).
- **STILL PLANNED, not started:** 17 findings, all in Plans 09/10/12/13/14 — M-1, M-7, M-8, M-9, M-13, M-18, M-19, M-24, L-14, L-26, L-27, L-29, L-30, L-32, L-33, L-34, L-35.
- **REQUIRES-VERIFICATION, still open:** 2 — H-2 (Plan 04 Task 5 preview probe, deliberately held for a manual operator run) and §6.3. M-25, L-25 and L-40 closed 2026-08-14 via the operator dashboard pass (see the verification log).
- **DEFERRED (with rationale):** unchanged — 19 detailed + the undetailed-range set — M-20, L-1, L-8, L-9, L-11, L-16, L-17, L-18, L-20, L-23, L-31, L-38, plus §6 features 4/5(wire)/6/7/10/12/13, Opp-5/9/16-23, and the un-enumerated L-2/L-3/L-28/L-36/L-37 (backlog, pending the audit's full master ledger).
- **STALE/ALREADY-RESOLVED:** 0 — every **non-refuted** finding remains applicable or requires verification at HEAD `3da7ee0`. (H-2 is `[REFUTED]` in the audit — not an active bypass; it carries only a residual defense-in-depth hardening item, tracked under REQUIRES-VERIFICATION / Plan 09, not yet started.)
- **NEW FINDINGS:** 1 (NF-1, LOW — folded into Plan 09/L-30, not yet started).

## Optional backlog (NOT remediation)

Kept explicitly separate per scope: §6 features 4/5/6/7/10/12/13, Opp-9, Opp-16…23, L-18/L-20/L-23, and the un-enumerated Low range. These are growth/nicety/by-design items; none guards an active defect. Do not bundle them into remediation PRs — they get their own tickets after P0–P2 land.
