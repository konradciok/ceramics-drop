# Ceramics ⇄ Prints separation — master plan

> **Source:** `docs/audit-ceramics-prints-separation.md` (audit dated 2026-07-07, commit `2295686`). This plan turns every finding and recommendation from that audit into executable work.
> **Executor:** Claude Fable 5, running long-horizon autonomous sessions. This document is written for that model — see [How to execute](#how-to-execute-this-plan).
> **Layout:** one master doc (this file, shared context) + seven self-contained domain plans, each independently shippable and self-verifying.

---

## Goal

The ceramics ⇄ prints separation is **correct on the critical payment path** (cart → checkout → webhook → fulfilment) and must stay that way. The work here closes the gaps the audit found **after payment**: the order lifecycle (refunds/disputes), the admin back-office, returns, customer/studio emails, one architecture hardening pass, two UX guards, and the near-zero test coverage of the print server path.

**Do not re-architect the happy path.** The mixed-cart block, the server-side delivery rules, and the DB-driven fulfilment routing are deliberate and working. Protect them; don't rewrite them.

---

## How to execute this plan

You are Claude Fable 5. You work best from a clear goal + hard constraints + concrete acceptance criteria, running autonomously and verifying your own work — not from micro-scripted steps. These plans are written that way on purpose: they tell you *what* must be true and *why*, name the exact files, and give you the tests that must pass. You choose *how*.

Operating rules for this plan:

- **Effort.** Run at `high` effort for the domain plans; use `xhigh` for `05-architecture.md` (a DB migration + backfill + consumer switch — correctness matters more than speed). Routine one-line changes (e.g. `03-returns.md`) can run at `medium`.
- **One domain at a time.** Each domain plan is a self-contained unit with its own Definition of Done. Finish and verify one before starting the next. Follow the [recommended order](#recommended-execution-order).
- **Keep a memory surface.** Create `docs/plans/ceramics-prints-separation/PROGRESS.md` (git-ignored is fine, or commit it) and record, per domain: decisions made, files touched, tests added, and anything you discovered that contradicts this plan. One short entry per domain. Consult it before starting each domain and when resuming.
- **Verify against something concrete, always.** Every behavioural change ships with a test. Run `npm run test` (and the file-scoped `npx vitest run <path>`) and `npm run lint` before declaring a domain done. Never claim a test passes without having run it and seen the output.
- **Ground every progress claim in a tool result.** If you say "the guard rejects print-only orders," point at the passing test. If something isn't verified yet, say so.
- **Respect the boundaries.** Do only what a domain plan asks. No drive-by refactors, no new abstractions, no speculative flexibility, no error handling for cases that cannot happen. A bug fix does not need surrounding cleanup. This repo runs Ponytail conventions — the laziest change that fully works is the correct one. When you take a deliberate shortcut, mark it `// ponytail: <reason>`.
- **Delegate reads in parallel.** When a domain plan spans several files, dispatch sub-agents to read them concurrently; keep the main thread for the edit + verify loop.
- **If a domain is blocked on a real business/product decision** that this plan hasn't already settled (see [Settled decisions](#settled-decisions)), stop and surface it — do not guess. Everything the audit left open has been decided below; if you hit a *new* ambiguity, raise it.

Prompt yourself before each domain with the intent, not just the task: *"I'm separating prints from ceramics so the studio doesn't lose money on POD orders and the back-office stops lying about their state. With that in mind: <domain goal>."*

---

## The domain model (the one invariant everything rests on)

There are exactly **two product kinds** in this store. There is no third kind.

| | **Ceramics** (one-of-a-kind) | **Fine-art prints** (print-on-demand) |
|---|---|---|
| Registry | `src/lib/products.ts` (static, `~125` pieces) | `src/lib/prints.ts` (`PRINT_DESIGNS`, `fap01…`) |
| Cart token | bare id, e.g. `k01` | `print:<design>:<size>:<framed>:<mount>:<frameColour>` |
| Token test | `!isPrintToken(id)` | `isPrintToken(id)` (`src/lib/print-cart.ts:9`) |
| **Order-item discriminator** | `order_items.variant IS NULL` | `order_items.variant IS NOT NULL` |
| Reservation | `piece_state` reserved/sold (15-min TTL) | none — open edition |
| Fulfilment | InPost (`createOrderShipment`) | Prodigi queue (`enqueueProdigi` → `process-job.ts`) |
| Delivery | Paczkomat / kurier (PL only) / odbiór | kurier only, EU+UK, home address |
| `delivery_method='kurier'` means | **InPost courier** | **Prodigi courier** (overloaded — see Finding 8) |

**The discriminator of record is `order_items.variant` (NULL = ceramic).** Read it from the DB, never infer product kind from the request or from `delivery_method`. `05-architecture.md` adds an explicit `orders.fulfilment_type` column to make this legible, but until then — and in every plan except 05 — `order_items.variant` is the truth.

A **mixed cart (ceramics + prints) is blocked by design** on three layers (PDP, cart UI, and server `validateCart` → `mixed_cart`). Keep it blocked. Separate fulfilment routes, costs, delivery windows, and shipping accounting make a single combined order not worth the split-payment machinery at this store's scale. This is a **settled** architectural decision, not a gap.

---

## Global invariants & constraints

Every task's requirements implicitly include these. Copied verbatim from `AGENTS.md`.

- **Build stays `next build --webpack`.** Never add `--turbo`, never switch to Turbopack — Turbopack chunks break at the Cloudflare Workers runtime (ChunkLoadError → HTTP 500 on every page). Non-negotiable.
- **Money is integer minor units at the Stripe boundary:** PLN grosze, EUR euro-cents, GBP pence. The analytics layer uses major units. `order_items.unit_price` and order totals are minor units in the order's currency.
- **Migrations** go in `supabase/migrations/` with a timestamp prefix newer than `20260705000000`. Additive/idempotent where possible.
- **i18n:** all UI strings live in `messages/{pl,en,es,de}.json` — update **all four** locales for any new copy. Server components use `getTranslations()`, client components `useTranslations()`. Import `Link`/`useRouter` from `src/i18n/navigation.ts`, never `next/*` directly.
- **`src/middleware.ts` must not be renamed** to `proxy.ts` (OpenNext rejects Node-runtime middleware). **`worker.ts` must keep re-exporting** `DOQueueHandler`, `DOShardedTagCache`, `BucketCachePurge` from `.open-next/worker.js`.
- **API error shape:** `NextResponse.json({ error: reason }, { status })`. Existing checkout codes: 400 (validation), 409 `unavailable`/`order_conflict`/`checkout_in_progress`, 502 `stripe_failed`, 500 (other).
- **Secrets never reach the client.** Prodigi/Stripe/Supabase-admin/conversion tokens only in API routes, the webhook, `src/server/*`, or scripts.

### Commands

```bash
npm run test                       # Vitest unit suite (src/**/*.test.ts)
npx vitest run <path/to/file>      # single test file
npm run lint                       # ESLint
npm run build                      # next build --webpack (must pass before a domain is "done")
npm run test:e2e                   # Playwright @ci specs (deployed site) — for 07 only
npm run sync-prodigi-skus          # reconcile Prodigi SKUs into pod_variants (context for 05)
```

---

## Settled decisions

The audit's §10 open questions are resolved as follows. Do not re-litigate these — implement them.

| # | Question | Decision |
|---|---|---|
| 1 | Refund/dispute of a print order vs Prodigi (Finding 1) | **Auto-cancel where possible, else alert.** If the Prodigi order is still cancellable (`GET /orders/{id}/actions` reports cancel available), call `POST /orders/{id}/actions/cancel`. If already in production/shipped, fire a Sentry alert **and** a studio email ("print refunded — cancel/absorb manually in Prodigi"). Never silently no-op. → `01-refund-lifecycle.md` |
| 2 | Do prints get returns? (Finding 4) | **No.** Print-only orders → `not_eligible`. POD items aren't returnable via the ceramic InPost locker path; defect handling stays a manual/support path. → `03-returns.md` |
| 3 | Mixed cart — keep separate orders? | **Yes, permanently.** Keep the block. No split-checkout. (See domain model above.) |
| 4 | Private-sale links ever include prints? (Finding 12) | **No.** Add an explicit `400` guard for `privateSaleToken && hasPrints` in checkout and declare it. → `05-architecture.md` |
| 5 | Multi-frame flat shipping (Finding 13) | **No code change now.** Keep the flat rate; add a monitoring note. Revisit with `POST /quotes` only when margin data shows the gap hurts. → `06-pdp-ux.md` |
| 6 | `pod_variants` source of truth vs `pod_variant_id` (Finding 9) | **Delete the dead column.** Drop `order_items.pod_variant_id`; `PRODIGI_SKU_MAP` stays the single source; `pod_variants` remains only the `sync-prodigi-skus` verification target. → `05-architecture.md` |
| 7 | Explicit "ceramics ship to PL only" UI message (Finding 10 companion) | **Yes.** Add the message where the courier/country choice is made. → `06-pdp-ux.md` |
| — | `orders.fulfilment_type` column (Finding 8) | **In scope.** Add it as the Phase-2 keystone; backfill from `order_items`; switch consumers gradually. → `05-architecture.md` |

---

## Plan index & finding coverage

| Plan | Findings | Severity | Summary |
|---|---|---|---|
| [`01-refund-lifecycle.md`](./01-refund-lifecycle.md) | 1 | **High** | Prodigi cancel-or-alert on refund/dispute. The one place money actually leaks today. |
| [`02-admin.md`](./02-admin.md) | 2, 3 | **High** / Medium | Guard admin create-shipment against print orders; make the dashboard/KPI print-aware. |
| [`03-returns.md`](./03-returns.md) | 4 | Medium | Print-only orders → `not_eligible` in `createOrderReturn`. |
| [`04-emails.md`](./04-emails.md) | 5, 6, 7 | Medium | Print confirmation copy; Prodigi shipping/tracking email; `variant` in the studio email select. |
| [`05-architecture.md`](./05-architecture.md) | 8, 9, 12 | Medium / Low | `orders.fulfilment_type` migration + backfill; drop dead `pod_variant_id`; private-sale × prints guard. |
| [`06-pdp-ux.md`](./06-pdp-ux.md) | 10, 13 | Low | Mirror the mixed-cart guard onto ceramic add-to-cart; "ceramics ship to PL only" message; multi-frame shipping monitoring note. |
| [`07-regression-e2e.md`](./07-regression-e2e.md) | 11 | **High** (regression risk) | Tests for the correct-but-untested print path: checkout branch, webhook routing, `enqueue`, `callbacks`, `process-job` happy path, InPost webhook route; E2E print-purchase + mixed-cart. |

All 13 findings are covered. Finding 11 (test coverage) is split: tests for *new* behaviour live in that behaviour's own domain plan as acceptance criteria; tests that protect *existing correct* behaviour live in `07`.

---

## Recommended execution order

Each plan is independent (uses the `order_items.variant` discriminator, which exists today), so they can ship in any order or in parallel across sub-agents. Recommended sequence, money-and-risk first:

1. **`01-refund-lifecycle.md`** — stops the active money leak. Ship first.
2. **`03-returns.md`** — one-line guard + test. Fast win.
3. **`02-admin.md`** — removes the false "blocked" signal that lures the admin into the Finding-2 mistake.
4. **`04-emails.md`** — customer/studio comms (F7 is trivial; F5/F6 are the substance).
5. **`05-architecture.md`** — migration + backfill + guard + drop column. Run at `xhigh`.
6. **`06-pdp-ux.md`** — small UX guards.
7. **`07-regression-e2e.md`** — lock everything down against regression.

**Dependency notes:**
- `01` adds a `cancelOrder` method to `src/server/prodigi/client.ts`; nothing else depends on it.
- `05` introduces `orders.fulfilment_type`. If you run `05` *before* `02`/`03`/`04`, those plans may read `fulfilment_type` instead of joining `order_items.variant` (cleaner). If you run them *first*, use `variant` — both are correct. Each plan states its discriminator explicitly so order doesn't matter.
- No plan blocks another. Commit per domain.

---

## Definition of done (global)

A domain is done only when **all** of these hold — verified, not assumed:

- [ ] Every behavioural change has a test that fails without the change and passes with it.
- [ ] `npm run test` is green (run it; paste/observe the summary).
- [ ] `npm run lint` is clean.
- [ ] `npm run build` succeeds (`next build --webpack`).
- [ ] New copy exists in **all four** `messages/*.json` locales (if the domain adds UI/email strings).
- [ ] `PROGRESS.md` has an entry for the domain: what changed, files, tests, surprises.
- [ ] The domain plan's own **Acceptance criteria** are all checked.

The whole plan is done when all seven domains are done and `07`'s E2E specs pass against a preview/deploy.
