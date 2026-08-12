# Backend Audit Remediation — Master Plan Index (2026-08-12)

> **For agentic workers:** this is the index. Each remediation plan below is a standalone, independently-executable file carrying the full `superpowers:writing-plans` structure (Objective / Findings / Current-state evidence / Scope / Out-of-scope / Steps / DB work / External changes / Tests / Verification / Rollout / Acceptance / Dependencies / Risks). Execute plans in the order given, respecting the dependency notes. Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` per plan.

**Source audit:** `docs/audits/backend-audit-2026-08-12.md` (1 CRITICAL · 1 HIGH · 29 MEDIUM · 44 LOW · 15 incomplete features · 23 opportunities).

**Planning baseline:** all evidence re-verified read-only against **HEAD `3da7ee0`** (`docs/context-refresh`) on 2026-08-12 by four inspection passes (Stripe/webhook, queue/worker/Prodigi, Supabase/data, auth/admin/misc). **No finding was found already-resolved** — every **non-refuted** finding remains applicable or requires verification at HEAD (H-2 is `[REFUTED]` in the audit: not an active bypass, only a residual hardening item — see Plan 09). Four audit **line-number/scope corrections** surfaced and are carried into the owning plans (see "Audit corrections" below). This is a **planning stage only** — no code, migration, config, or data was changed; the only repository changes are these plan files.

---

## Execution order & plan roster

| # | Plan file | Priority | Findings covered | Live/external gate? | Depends on |
|---|---|---|---|---|---|
| 00 | `…-00-master-index.md` (this) | — | ledger | — | — |
| 04 | `…-04-live-config-verification.md` | **P0** (read-only, run first) | H-4, M-6*, M-25, L-25, H-2*, L-40, §15.1/.9 | Read-only dashboard/CLI access | none |
| 01 | `…-01-stripe-refund-reconciliation.md` | **P0** | C-1, H-3, M-28, Opp-2, Opp-3 | **YES** — Stripe `enabled_events` + prod backfill | none (folds §15.1) |
| 02 | `…-02-queue-context-fix.md` | **P0** | C-2, M-10, M-23, L-21, Opp-6 | Preview rehearsal is the exit gate | 03 (alerts) — Plan 05 is 02's runtime **exit gate**, not an upstream dependency |
| 03 | `…-03-worker-sentry-cron-alerting.md` | **P0** | M-16, M-15, §15.9(partial) | `wrangler secret list` (read); DSN set if missing (gated) | none |
| 05 | `…-05-print-pipeline-rehearsal.md` | **P0 exit gate** | L-15, L-22, §15.2, §15.8, §6.11(observe) | **YES** — preview deploy + Stripe test-mode + Prodigi sandbox | 01(Task5), 02, 03 |
| 06 | `…-06-stripe-webhook-hardening.md` | **P1** | H-1, M-5, M-21, M-22, M-27, L-4, L-5, L-6, L-7 | none (preview validation) | 01 (same files) |
| 07 | `…-07-supabase-hardening.md` | **P1** | M-2, M-3, M-4, L-10, L-12, L-13 | **YES** — migration auto-applies to prod on merge | Task 0 live reads |
| 08 | `…-08-env-completeness.md` | **P1** | M-17, Opp-12(env half) | none | none |
| 09 | `…-09-admin-auth-hardening.md` | **P2** | M-7, M-6, H-2(residual), M-1, L-26, L-27, L-29, L-30 | Sequencing gate on `ADMIN_ALLOWED_EMAILS` | 04(Tasks 2,5), 03 |
| 10 | `…-10-global-rate-limiting.md` | **P2** | M-8, M-9, §6.1, Opp-1 | Binding deploy (possible beta toggle) | none |
| 11 | `…-11-prodigi-robustness.md` | **P2** | M-11, M-12, M-14, M-26, L-19, L-24, §6.11(resolve) | Prodigi sandbox (standard) | 02, 05, 03 |
| 12 | `…-12-oversell-worker-test-coverage.md` | **P2** | M-18, M-19, Opp-8, Opp-12(extraction half) | none | 02, 03, 07(soft) |
| 13 | `…-13-inpost-webhook-hardening.md` | **P2** | M-13, L-34, L-35 | **YES** — `INPOST_WEBHOOK_TOKEN` rotation + panel re-register | none |
| 14 | `…-14-platform-hygiene.md` | **P2/P3** | L-33, L-32, M-24, L-14, Opp-11/13/14 | Possible R2 bucket (adopt branch), gated | none |

`*` M-6 and H-2 are split: **verification** of severity/empirics is Plan 04; **code hardening** is Plan 09.

### Recommended sequencing

1. **First wave (parallel):** Plan 04 (read-only verification — feeds several downstream plans), Plan 08 (env, trivial, independent), Plan 03 (worker Sentry — prerequisite for 02/05 alerts).
2. **P0 money/fulfilment core:** Plan 01 (refunds) → Plan 02 (queue fix) → Plan 05 (rehearsal, gates prints). Plan 01 and Plan 02 are independent of each other; both should complete before Plan 05.
3. **P1 hardening:** Plan 06 (after 01 — shared files), Plan 07 (migration; independent), Plan 08 (any time).
4. **P2:** Plans 09 (after 04), 10, 11 (after 02/05), 12 (after 02/03), 13, 14 — largely parallel; watch `worker.ts` merge contention between 02/03/11/14.

### Live/external execution gates (require explicit operator approval at implementation time)

- **Plan 01:** add `charge.refunded`+`refund.failed` to the live Stripe endpoint; backfill order `8be30881…`/piece `s15`.
- **Plan 07:** the hardening migration auto-applies to prod on merge to `main` (~1 min, before the Workers build) — the merge **is** the mutation; write backward-compatible (the plan verifies this).
- **Plan 13:** rotate `INPOST_WEBHOOK_TOKEN` + re-register the panel URL.
- **Plan 03/04/09:** possible prod secret sets / Access-policy tightening if the read-only checks find gaps.
- **Plan 05:** preview/sandbox/test-mode mutations only — never production-live.
- **Plan 14:** R2 bucket creation only if the M-24 "adopt" branch is chosen.

---

## Finding-status ledger

Every finding ID from the audit, with its status. Statuses: **PLANNED** (assigned to a remediation plan), **REQUIRES-VERIFICATION** (a read-only/runtime check gates the fix or its severity — owned by a plan), **DEFERRED** (consciously out of remediation scope, rationale given), **STALE/ALREADY-RESOLVED** (none). No finding is left without a status.

### Critical & High (§4)

| ID | Severity (adjudicated) | Status | Plan |
|---|---|---|---|
| C-1 | CRITICAL | PLANNED | 01 |
| C-2 | HIGH | PLANNED | 02 (runtime verify: 05) |
| H-1 | MEDIUM | PLANNED | 06 |
| H-2 | LOW (refuted) | REQUIRES-VERIFICATION → PLANNED (residual) | 04 (probe) + 09 (normalize) |
| H-3 | MEDIUM | PLANNED (`refund.failed` leg; full event-model migration DEFERRED) | 01 |
| H-4 | MEDIUM | REQUIRES-VERIFICATION | 04 |

### Medium (§5)

| ID | Status | Plan / rationale |
|---|---|---|
| M-1 | PLANNED | 09 (verified-email guard) |
| M-2 | PLANNED | 07 |
| M-3 | PLANNED (+ live policy-name read) | 07 |
| M-4 | PLANNED | 07 |
| M-5 | PLANNED | 06 |
| M-6 | REQUIRES-VERIFICATION (04) → PLANNED (09) | 04 + 09 |
| M-7 | PLANNED | 09 |
| M-8 | PLANNED | 10 |
| M-9 | PLANNED | 10 |
| M-10 | PLANNED | 02 |
| M-11 | PLANNED | 11 |
| M-12 | PLANNED | 11 |
| M-13 | PLANNED | 13 |
| M-14 | PLANNED | 11 |
| M-15 | PLANNED | 03 |
| M-16 | PLANNED | 03 |
| M-17 | PLANNED | 08 |
| M-18 | PLANNED | 12 |
| M-19 | PLANNED (scope corrected — see corrections) | 12 |
| M-20 | DEFERRED — ack-fast/queue rearchitecture of the webhook; risk bounded by Stripe's 3-day retry + Plan 06's error-handling fixes at current volume. Revisit on latency alarms/volume. | 06 (noted) |
| M-21 | PLANNED | 06 |
| M-22 | PLANNED | 06 |
| M-23 | PLANNED | 02 |
| M-24 | PLANNED (adopt-or-remove spike) | 14 |
| M-25 | REQUIRES-VERIFICATION | 04 (rotation = gated follow-up if legacy) |
| M-26 | PLANNED | 11 |
| M-27 | PLANNED | 06 |
| M-28 | PLANNED | 01 |

### Low (§5) — detailed in the audit body

| ID | Status | Plan / rationale |
|---|---|---|
| L-1 | DEFERRED — validateCart DB-amplification; partly mitigated by Plan 10's checkout limit; cheap guard-reorder can ride a future checkout change. | 10 (noted) |
| L-4 | PLANNED | 06 |
| L-5 | PLANNED (alert only; invoice retry/backfill stays deferred) | 06 |
| L-6 | PLANNED | 06 |
| L-7 | PLANNED | 06 |
| L-8 | DEFERRED — residual lock-ordering window; documented (not fixed) by Plan 12's pgTAP. | 12 (noted) |
| L-9 | DEFERRED — CMS audit-row-outside-txn; editorial-surface-only, non-money-path; in-repo fix pattern exists for a future CMS change. | 07 (noted) |
| L-10 | PLANNED | 07 |
| L-11 | DEFERRED — `FOR SHARE` phantom-INSERT window; admin-only, theoretical; revisit if variants become user-writable. | 07 (noted) |
| L-12 | PLANNED | 07 |
| L-13 | PLANNED (target column corrected — see corrections) | 07 |
| L-14 | PLANNED | 14 |
| L-15 | REQUIRES-VERIFICATION (never run in prod) | 05 |
| L-16 | DEFERRED — attemptId oracle infeasible at 122-bit entropy (audit's own assessment). | 09 (noted) |
| L-17 | DEFERRED — intentional FK gaps; docs-only clarification, no behaviour change. | 07 (noted) |
| L-18 | DEFERRED — leaked-password protection off; moot while OAuth-only (per audit). Revisit before enabling email/password. | backlog |
| L-19 | PLANNED | 11 |
| L-20 | DEFERRED — USD/CAD dead-but-valid CHECK values by design. | backlog |
| L-21 | PLANNED | 02 |
| L-22 | REQUIRES-VERIFICATION (contract assumptions observed in rehearsal) | 05 (input) → 11 |
| L-23 | DEFERRED — `PRINT_ASSET_TOKEN_SECRET` key-versioned rotation; audit §13-extended item, not a defect today. | 11 (noted) → backlog |
| L-24 | PLANNED | 11 |
| L-25 | REQUIRES-VERIFICATION | 04 |
| L-26 | PLANNED | 09 |
| L-27 | PLANNED | 09 |
| L-29 | PLANNED | 09 |
| L-30 | PLANNED (bonus: the "gitignored/never-committed" comment is factually false — file is tracked; see corrections) | 09 |
| L-31 | DEFERRED — `/api/returns` capability token assessed deliberate + well-hardened (audit). | 09 (noted) |
| L-32 | PLANNED | 14 |
| L-33 | PLANNED (headers half; CSP-enforce cutover explicitly out of scope) | 14 |
| L-34 | PLANNED | 13 |
| L-35 | PLANNED | 13 |
| L-38 | DEFERRED — newsletter scanner auto-confirm; §6.12 product decision ("ship when scanner-confirms show up in practice"), already accepted-in-code. | backlog |
| L-39 | REQUIRES-VERIFICATION then closed — `debug/fulfilment-status` safe only by never setting its token in prod; Plan 04 Task 6 confirms `FULFILMENT_DEBUG_TOKEN` absent in prod. | 04 |
| L-40 | REQUIRES-VERIFICATION — ceramic EUR/GBP display-vs-charge parity (read-only data check). | 04 (Task 7) |

**Low IDs not individually enumerated in the audit body** (L-2, L-3, L-28, L-36, L-37): the audit compresses these into range notation ("L-32…L-40") and references a "master ledger §C" not present in the working tree. → **DEFERRED to backlog**, flagged for the operator to retrieve from the audit's full ledger before closing the audit. Not blockers for any P0–P2 remediation.

### Incomplete/partial features (§6)

| # | Feature | Status | Plan / rationale |
|---|---|---|---|
| 1 | Global (WAF) rate limiting | PLANNED | 10 |
| 2 | Refund lifecycle (webhook leg) | PLANNED | 01 |
| 3 | Ledger + Prodigi pipeline in prod | REQUIRES-VERIFICATION | 05 |
| 4 | Quantity stock reservation | DEFERRED — wire only when print inventory limits are needed (not a defect; prints are unlimited-by-design). | backlog |
| 5 | Per-product EUR/GBP + sale prices | REQUIRES-VERIFICATION (parity) → DEFERRED (wire-or-remove) | 04 (verify) + backlog |
| 6 | `products.slug` pretty URLs | DEFERRED — dead admin capability; build routing or hide the field. | backlog |
| 7 | `pod_variants` consumed catalogue | DEFERRED — document as verification-only or consume. | backlog |
| 8 | Worker-scope Sentry | PLANNED | 03 |
| 9 | CSP enforce + API security headers | PLANNED (headers) / DEFERRED (CSP-enforce cutover — pending deploy op) | 14 |
| 10 | Workers traces (`enabled:false`) | DEFERRED — enable or remove; observability nicety. | backlog |
| 11 | `in_production` fulfilment stage | REQUIRES-VERIFICATION → PLANNED (keep/remove) | 05 (observe) + 11 (resolve) |
| 12 | Newsletter human-confirmation | DEFERRED — product decision (L-38). | backlog |
| 13 | Abandoned-cart recovery | DEFERRED — product/consent decision (automation disabled per prior memory). | backlog |

### Feature-development opportunities (§13) — remediation-relevant only

Grounded opportunities that **close or guard a specific finding** are folded into plans; independent growth features are excluded from remediation per scope.

| Opp | Status | Plan |
|---|---|---|
| Opp-1 (native rate-limit binding) | PLANNED | 10 |
| Opp-2 (webhook-config drift guard) | PLANNED | 01 |
| Opp-3 (refund reconciliation sweep) | PLANNED | 01 |
| Opp-4 (cron Prodigi reconciliation) | PLANNED | 11 |
| Opp-5 (print reconcile-mode CLI) | DEFERRED — cron sweep (11) covers the automated case; add CLI only if DLQ manual recovery proves clumsy. | 11 (noted) |
| Opp-6 (queue-context lint/test guard) | PLANNED | 02 |
| Opp-7 (RPC surface hardening migration) | PLANNED | 07 |
| Opp-8 (pgTAP CI for reserve_pieces) | PLANNED | 12 |
| Opp-9 (authenticated-user RLS on orders) | DEFERRED — defense-in-depth, costs nothing but not guarding an active defect. | backlog |
| Opp-10 (alert on charge.dispute.created) | PLANNED | 06 (L-6) |
| Opp-11 (retention/pruning cron) | PLANNED | 14 (L-14) |
| Opp-12 (env test + cancelIntent matrix) | PLANNED | 08 (env) + 12 (cancelIntent) |
| Opp-13 (cache the merchant feeds) | PLANNED | 14 (L-32) |
| Opp-14 (security-header block in worker) | PLANNED | 14 (L-33) |
| Opp-15 (shorten TTL + redact asset URLs) | PLANNED | 11 (M-14) |
| Opp-16…23 (extended ledger: HMAC rotation, status-vocabulary single-source, composite indexes, Resend svix-id dedup, per-market parity, …) | DEFERRED — partial coverage lands opportunistically (status vocab → 07 L-13; parity → 04 L-40; svix-id → adjacent to M-27); the rest is backlog. | backlog |

### Verification gaps (§15) — ownership

| § | Gap | Owner |
|---|---|---|
| 15.1 | Stripe v2 Event Destinations | 01 (Task 5 pre-check) |
| 15.2 | C-2 runtime throw (post-fix: success) | 02 → 05 |
| 15.3 | H-2 admin-gate variant probes | 04 (Task 5) |
| 15.4 | H-4 admin-editor error host | 04 (Task 1) |
| 15.5 | M-6 Access-policy breadth + allowlist presence | 04 (Task 2) |
| 15.6 | M-25 Supabase key format | 04 (Task 3) |
| 15.7 | L-25 R2 bucket posture | 04 (Task 4) |
| 15.8 | Whole pipeline rehearsal + alert channels | 05 |
| 15.9 | Prod secret-name presence | 04 (Task 6) + 03 (Task 3) |

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

- **PLANNED:** 47 findings — C-1, C-2, H-1, H-3(partial), M-1, M-2, M-3, M-4, M-5, M-7, M-8, M-9, M-10, M-11, M-12, M-13, M-14, M-15, M-16, M-17, M-18, M-19, M-21, M-22, M-23, M-24, M-26, M-27, M-28, L-4, L-5, L-6, L-7, L-10, L-12, L-13, L-14, L-19, L-24, L-26, L-27, L-29, L-30, L-32, L-33, L-34, L-35. *(count verified against the ledger above — L-14 → Plan 14 is included.)*
- **REQUIRES-VERIFICATION:** 11 — H-2, H-4, M-6, M-25, L-15, L-22, L-25, L-39, L-40, §6.3, §6.11 (each owned by Plan 04 or 05, with a decision fork into an implementation plan).
- **DEFERRED (with rationale):** 19 detailed + the undetailed-range set — M-20, L-1, L-8, L-9, L-11, L-16, L-17, L-18, L-20, L-23, L-31, L-38, plus §6 features 4/5(wire)/6/7/10/12/13, Opp-5/9/16-23, and the un-enumerated L-2/L-3/L-28/L-36/L-37 (backlog, pending the audit's full master ledger).
- **STALE/ALREADY-RESOLVED:** 0 — every **non-refuted** finding remains applicable or requires verification at HEAD `3da7ee0`. (H-2 is `[REFUTED]` in the audit — not an active bypass; it carries only a residual defense-in-depth hardening item, tracked under REQUIRES-VERIFICATION / Plan 09.)
- **NEW FINDINGS:** 1 (NF-1, LOW — folded into Plan 09/L-30).

## Optional backlog (NOT remediation)

Kept explicitly separate per scope: §6 features 4/5/6/7/10/12/13, Opp-9, Opp-16…23, L-18/L-20/L-23, and the un-enumerated Low range. These are growth/nicety/by-design items; none guards an active defect. Do not bundle them into remediation PRs — they get their own tickets after P0–P2 land.
