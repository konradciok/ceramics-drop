# Cleaning instructions for agents

**Generated:** 2026-07-14  
**Inputs:** `docs/pony-audit.md`, `docs/superpowers/specs/2026-07-13-prodigy-audit.md`, independent codebase verification.

This document is the **actionable** layer. The two audit files remain useful **reference material**, not a live source of truth — several findings are already fixed, and one pony-audit correction (CATALOG_SOURCE) is critical to avoid deleting production code.

---

## How trustworthy are the audit docs?

| Document | Role | Trust level |
|----------|------|-------------|
| `docs/pony-audit.md` | De-bloat / mechanical dedup | **High** for Tier 1 mechanical items (#2, #3, #7, #9). **Do not act** on retracted items (CATALOG_SOURCE, admin DI, cart). USD/CAD removal (#1) is technically correct but is a product call — see task C-04. |
| `docs/superpowers/specs/2026-07-13-prodigy-audit.md` | Test coverage & ops gaps | **High** for remaining coverage gaps (H-2, M-4, M-5, L-7, O-1). **Stale** on items already landed — see §Already resolved. Operational items (M-6, M-7, M-8) are real gaps but are **features**, not cleanup — listed separately. |
| `CODE_CLEANING_PLAN.md` | Older (2026-07-07) plan | **Partial overlap** with pony-audit; prefer pony-audit + this file. |

### Ground truth the audits got wrong or that changed since

1. **`CATALOG_SOURCE=db` is live in production** (`wrangler.jsonc` → `"CATALOG_SOURCE": "db"`). Async product accessors call Supabase. **Do not delete** catalog DB code, registry sync helpers, or “premature async” seams — pony-audit retracted this correctly; `AGENTS.md` and inline comments in `src/lib/catalog/*.ts` are still wrong and actively dangerous.
2. **Already resolved since the Prodigi audit** (do not re-implement):
   - **L-6** — Prodigi callback uses `timingSafeEqual` (`src/app/api/webhooks/prodigi/[token]/route.ts`).
   - **L-8** — Playwright defaults to `http://localhost:3000` (`playwright.config.ts:20`).
   - **M-3** — Queue disposition extracted to `decideMessageDisposition` + unit tests (`src/server/fulfilment/queue-disposition.ts`, `worker.ts:53`).
   - **H-1 (partial)** — Sandbox contract smoke exists: `npm run prodigi:contract-smoke`, `.github/workflows/prodigi-contract-smoke.yml`, `src/server/prodigi/contract-smoke.ts`. Still workflow_dispatch-only and does not cover the full Stripe→queue→processJob path.

### What remains genuinely open (verified)

| ID | Finding | Evidence |
|----|---------|----------|
| H-2 | Destructive print E2E asserts success page only | `e2e/print-purchase.spec.ts:84` |
| M-4 | No pgTAP for fulfilment idempotency constraints | `supabase/tests/` has only `print_fulfilment_assets.sql`, `private-sale.sql` |
| M-5 | DLQ configured, no consumer or alert | `wrangler.jsonc:43`, manual runbook only |
| L-7 | Callback stale-lease CAS not tested | `callbacks.test.ts` covers fresh in-flight lease, not expired takeover |
| O-1 | `failed_action_required` jobs set `last_error` but no alert | `process-job.ts` terminal path; no cron sweep |
| Pony #2 | Nine scripts duplicate dotenv parsing (7 to migrate + 2 CLIs left as-is) | grep `parseEnvFile` in `scripts/` vs `scripts/lib/script-env.ts` |
| Pony #3 | Hand-rolled arg parsers outside `node:util parseArgs` | grep `function parseArgs` / `getArg` in `scripts/` |
| Pony #1 | USD/CAD scaffolding unreachable in live paths | `SELLABLE_CURRENCIES`, `toUSDCents`/`toCADCents` with 0 callers |
| Pony docs | Stale catalog documentation | `AGENTS.md:42`, `src/lib/catalog/source.ts:8-10`, `load.ts:9-10` |

---

## Agent rules (read before any task)

1. **One task per PR/commit** unless tasks are explicitly bundled (e.g. C-01 is docs-only and pairs naturally with nothing else).
2. **Verify before delete.** Grep for symbols across the whole repo; run `npm run typecheck && npm run test` after each task.
3. **Never remove:** CATALOG_SOURCE DB catalog path, admin DI factories, cart store, live Prodigi fulfilment methods (`postOrder`, `getOrder`, `getOrderActions`, `cancelOrder`).
4. **Do not swap** `src/lib/timing-safe-equal.ts` for `node:crypto` without auditing all call sites (length-mismatch behaviour differs).
5. **Do not delete** Prodigi CLI operator commands (`quote`, `order list`, `update-*`) unless the human owner explicitly opts in — they are unused by live fulfilment but used for debugging.
6. Prefer extending existing patterns (`scripts/lib/script-env.ts`, `node:util parseArgs`, pgTAP `BEGIN/ROLLBACK` style in `supabase/tests/`).

---

## Tier A — Safe, high ROI, do first

Mechanical or docs-only. Low regression risk. Estimated total: ~300–450 LOC removed or ~100 LOC tests/docs added.

### C-01 · Fix stale catalog documentation

**Source:** pony-audit “Non-code weakness”; verified `AGENTS.md` + catalog comments contradict `wrangler.jsonc`.  
**Risk:** None (docs only).  
**Why first:** Prevents a future agent from deleting live production code.

**Edit:**
- `AGENTS.md` — Product Registry paragraph: state that production uses `CATALOG_SOURCE=db`; `code` is local/test fallback; code registry remains structural source + sync helpers for client/admin surfaces.
- `src/lib/catalog/source.ts` — header comment (lines 8–10): remove “NOT yet wired into storefront accessors”.
- `src/lib/catalog/load.ts` — header comment (lines 9–10): same correction.
- Optionally align `docs/cloudflare-deployment.md` if it still reads like `db` is future-only.

**Acceptance:** Comments accurately describe current production; no code behaviour change.

---

### C-02 · Consolidate script env loading onto `script-env.ts`

**Source:** pony-audit #2.  
**Risk:** Low — behaviour already duplicated; `script-env.test.ts` covers precedence.

**Migrate these files to `import { loadLocalEnv, parseEnvFile } from './lib/script-env'`** (or `./lib/script-env` from subdirs):
- `scripts/create-drop.ts`
- `scripts/sync-prodigi-skus.ts`
- `scripts/export-inpost-bulk-csv.ts`
- `scripts/check-print-fulfilment-jobs.ts`
- `scripts/backfill-catalog.ts`
- `scripts/create-private-sale-link.ts`
- `scripts/debug-meta-capi.mjs` (may need a thin `.ts` wrapper or duplicate import path — prefer converting to `.ts` if trivial)

**Leave as-is for now:** `prodigi-cli.ts` / `orders-cli.ts` — they inject `parseEnvText` via DI for unit tests. Optional follow-up: re-export `parseEnvFile` as `parseEnvText` alias from `script-env.ts` and import in both CLIs (pony #5).

**Acceptance:** No local `parseEnvFile` / `loadLocalEnv` copies remain in migrated scripts; `npm run test` green; spot-check one script (`npm run prodigi:contract-smoke -- --help` or `npm run sync-prodigi-skus -- --dry-run` if supported).

---

### C-03 · Standardise script CLI parsing on `node:util parseArgs`

**Source:** pony-audit #3.  
**Risk:** Low per script if flags are covered by existing usage in docs.

**Convert hand-rolled parsers in:**
- `scripts/prodigi-contract-smoke.ts`
- `scripts/print-assets-sandbox-matrix.ts`
- `scripts/print-asset-smoke.ts`
- `scripts/create-drop.ts`
- `scripts/export-inpost-bulk-csv.ts`
- `scripts/create-private-sale-link.ts`
- `scripts/reconcile-orders.mjs` / `scripts/generate-product-notes.mjs` (convert to `.ts` when touching)

**Optional:** fold `scripts/lib/print-assets-cli.ts` `getArg`/`hasFlag` into `parseArgs` in the print-assets trio — slightly wider blast radius; do after the standalone scripts.

**Acceptance:** Each migrated script uses `parseArgs({ options, allowPositionals: true })`; help text / flag names unchanged; relevant script tests pass.

---

### C-04 · Remove dead USD/CAD currency scaffolding

**Source:** pony-audit #1.  
**Risk:** Low if grep confirms zero live callers. **Product gate:** AGENTS.md notes this was intentional pre-launch staging — confirm with owner if unsure.

**Delete / unwind:**
- `src/lib/pricing.ts` — `PRICE_USD`, `PRICE_CAD`, `toUSDCents`, `toCADCents`, `priceOfCurrency` usd/cad arms
- `src/lib/currency.ts` — `'usd'|'cad'` from `Currency`, `VALID_CURRENCIES`, `toChargeableCurrency` usd/cad mapping
- `src/lib/format.ts` — `usd()`, `cad()`, formatter cases
- `src/components/layout/CurrencySwitcher.tsx` — usd/cad label entries
- `src/lib/pricing.test.ts` — usd/cad throw tests (replace with “unsupported currency” coverage if needed)

**Keep:** PLN/EUR/GBP paths unchanged.

**Acceptance:** `npm run typecheck && npm run test`; grep shows no `toUSDCents` / `PRICE_USD` / `'usd'` in currency types.

---

### C-05 · Collapse `toGrosze` / `toEuroCents` / `toGBPPence` into one helper

**Source:** pony-audit #7.  
**Risk:** Very low.

**Change:** Add `toMinor(units: number): number` in `src/lib/pricing.ts` (or `src/lib/format.ts` if that’s where money helpers live); replace the three live wrappers and their call sites in checkout.

**Acceptance:** Same numeric behaviour; tests updated if they import the old names.

---

### C-06 · Micro-dedupes (single commit, multiple files)

**Source:** pony-audit #9.  
**Risk:** Very low.

| Item | Action |
|------|--------|
| `printItemAssetKey` in `mapper.ts` | Inline at sole caller in `process-job.ts` |
| `runId()` / `defaultRunId()` | Shared helper in `scripts/lib/` used by contract-smoke + sandbox-matrix |
| `localizedPath` | Extract to `src/lib/admin/` or `src/lib/i18n-path.ts`; import from publish + preview routes |
| `UUID_RE` in checkout route | Use existing `isUuid` from `src/lib/admin/data.ts` **only if** coupling is acceptable; otherwise extract `isUuid` to `src/lib/uuid.ts` shared by admin + checkout |

**Acceptance:** Net LOC down; no behaviour change; tests green.

---

### C-07 · pgTAP: fulfilment idempotency constraints

**Source:** Prodigi audit M-4.  
**Risk:** Low — additive test file; follows existing pgTAP pattern.

**Add:** `supabase/tests/fulfilment_idempotency.sql` asserting (via `BEGIN`/`ROLLBACK`):
1. Duplicate `fulfilment_jobs.idempotency_key` → `23505`
2. Duplicate `(provider, provider_event_id)` on `webhook_events` → `23505`
3. Second **active** job for same `order_id` rejected; cancelled job for same order allowed

Mirror fixture style from `supabase/tests/print_fulfilment_assets.sql`. Reference migrations `20260626120002_fulfilment_jobs.sql`, `20260626120003_webhook_events.sql`.

**Acceptance:** `supabase test db` passes locally (document in PR if CI doesn’t run pgTAP yet).

---

### C-08 · Unit test: callback stale-lease CAS takeover

**Source:** Prodigi audit L-7.  
**Risk:** None — test only.

**Add** to `src/server/prodigi/callbacks.test.ts`: existing event `{ status: 'processing', processing_started_at: <now - LEASE_MINUTES - 1> }` → handler proceeds (mock `getOrder` called), event ends `done`.

**Acceptance:** New test fails if CAS takeover regresses; `npx vitest run src/server/prodigi/callbacks.test.ts` green.

---

### C-09 · Fix hoisted `ProdigiError` mock constructor

**Source:** Prodigi audit I-10.  
**Risk:** None.

**Change:** In `src/server/fulfilment/process-job.test.ts`, import real `ProdigiError` from `../prodigi/client` in the mock factory instead of redeclaring `(m,s,b,r)`.

**Acceptance:** 409 recovery test still passes; signature drift would now surface.

---

## Tier B — High impact, moderate effort (still safe if scoped)

These improve robustness but touch runtime behaviour or ops wiring. One task each; read the cited source files first.

### C-10 · DLQ consumer with alert

**Source:** M-5.  
**Risk:** Medium — new worker queue handler.

**Scope:** Add a consumer for `prodigi-fulfilment-dlq` in `wrangler.jsonc` + `worker.ts` that logs structured JSON, sends Sentry message, and emails studio (reuse patterns from `cancel-print.ts` alerts). No auto-retry from DLQ in v1 — alert-only.

**Acceptance:** Manual test with a poison message in sandbox DLQ; alert received.

---

### C-11 · Cron alert for `failed_action_required` fulfilment jobs

**Source:** O-1.  
**Risk:** Medium — extend `worker.ts` scheduled handler or add second cron.

**Scope:** Query `fulfilment_jobs` where `status = 'failed_action_required'` and `alerted_at IS NULL` (add column if needed, or dedupe via a small `fulfilment_alerts` table — prefer minimal schema). Email studio + Sentry. Reuse `check-print-fulfilment-jobs.ts` query logic.

**Acceptance:** Staging job in `failed_action_required` triggers one email; idempotent on re-run.

---

### C-12 · Destructive print E2E: assert fulfilment state

**Source:** H-2.  
**Risk:** Medium — needs sandbox Stripe + Supabase read path.

**Scope:** After payment in `e2e/print-purchase.spec.ts` `@destructive` block, poll (via `npm run orders -- order get <id>` subprocess, admin API, or new read-only debug route) until `fulfilment_jobs.status` reaches `fulfilment_submitted` or `prodigi_orders.prodigi_order_id` is set. Keep behind `E2E_PRODIGI_SANDBOX=1`.

**Acceptance:** Spec fails if enqueue/processJob regresses; still excluded from default CI via `@destructive`.

---

## Tier C — Real gaps, not “cleaning” (do not start without owner sign-off)

| ID | Item | Why deferred |
|----|------|--------------|
| M-6 | Admin fulfilment UI shows Prodigi state | New UI/feature |
| M-7 | Admin retry-fulfilment route | New mutation; schema constraints |
| M-8 | `reconcile-orders` print backfill | New operator tool surface |
| B-1 | Multi-frame flat shipping | Settled business decision |
| B-2 | 409 duplicate without order id recovery | Fulfilment logic change |
| B-3 | Shipping email exhaustion marks event `done` | Callback semantics change |
| Pony #4 | Delete speculative Prodigi client methods | Operator CLI still uses them |
| Pony #5 | Dedupe prodigi-cli / orders-cli scaffold | Judgment call; do after C-02 |
| Pony #6 | Inline contract-smoke orchestrator | H-1 smoke + unit tests exist; marginal gain |

---

## Suggested execution order

```
C-01 → C-02 → C-03 → C-05 → C-06 → C-09 → C-08 → C-07 → C-04
```

Then Tier B as capacity allows: **C-10 → C-11 → C-12**.

C-04 last among Tier A only because it is the one item with a documented product caveat; everything else is uncontroversial.

---

## Verification checklist (every Tier A/B task)

```bash
npm run typecheck
npm run test
npm run lint
```

For script changes, also run the touched script with `--help` or `--dry-run`.  
For pgTAP (C-07): `supabase test db`.  
For E2E (C-12): `E2E_DESTRUCTIVE=1 E2E_PRODIGI_SANDBOX=1 npm run test:e2e -- e2e/print-purchase.spec.ts`.

---

## Quick reference: do not redo

| Item | Status |
|------|--------|
| Prodigi callback `timingSafeEqual` | ✅ Done |
| Playwright localhost default | ✅ Done |
| `decideMessageDisposition` + tests | ✅ Done |
| Prodigi sandbox contract smoke workflow | ✅ Done (manual CI) |
| CATALOG_SOURCE DB catalog | ✅ Live — do not remove |
