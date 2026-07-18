# Stripe Stage-One Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> At execution start, copy this plan into the repo at `docs/superpowers/plans/2026-07-18-stripe-stage-one-robustness.md` (commit it with Task 1).
>
> Infra note: during planning, `Agent` subagent dispatch failed twice with a `glm-5.2` model-routing error. If subagent dispatch fails at execution time, fall back to inline execution (superpowers:executing-plans).

**Goal:** Close the two real webhook recovery holes found by the Stripe stage-one audit (verified against code), externalize the hardcoded Stripe PMC id, make swallowed invoice failures discoverable, restore two remote-only DB migrations into repo history, and add a one-page Stripe operations runbook — **without** the audit's proposed event-ledger/lease/processor-v2 machinery, which was assessed as over-engineering.

**Context (why):** The audit in `plan-stripe-stage-one-audit/` was reviewed against the actual code. Confirmed real: (1) `releaseSale` in the Stripe webhook flips `orders.status paid→refunded` and then releases `piece_state` rows in a second request — if the second write fails, the Stripe retry hits an empty CAS and **never finishes the relist** (the code comment at `src/app/api/stripe/webhook/route.ts:355-357` wrongly claims the retry works); (2) a full refund/lost dispute delivered **before** `payment_intent.succeeded` no-ops while the order is `pending`, so the late success fulfils a refunded payment; (3) `src/app/api/checkout/route.ts:23` hardcodes a live-mode `pmc_…` id that does not exist in the test account; (4) `ensureInvoiced` failures are Sentry-only with no re-run surface (`scripts/reconcile-orders.mjs` has zero invoice coverage); (5) remote Supabase has two applied migrations missing from the repo. Rejected from the audit: `stripe_webhook_events` ledger table, lease/attempt semantics, `STRIPE_WEBHOOK_PROCESSOR_V2` shadow rollout, security-definer release RPC + pgTAP — every side effect already has its own idempotency guard and Stripe Workbench is the delivery ledger.

**Architecture:** All fixes reuse existing in-repo patterns: the `releaseSale` fix mirrors the `releaseHold` retry-fallback already in the same file; the PMC change applies an already-authored unmerged commit (`e8e8f91` on `staging-development`); invoice visibility extends `scripts/reconcile-orders.mjs`'s discover/report pattern read-only; migrations are restored verbatim from `supabase_migrations.schema_migrations` (already fetched — SQL embedded below). No new tables, no new deps, no new modules.

**Tech Stack:** Next.js 16 App Router on Cloudflare Workers (OpenNext), Stripe SDK, Supabase (service-role), Vitest, plain Node `.mjs` operator scripts.

## Global Constraints

- Build stays `next build --webpack`. NEVER add `--turbo` or suggest Turbopack (breaks Cloudflare Workers runtime).
- Do not rename `src/middleware.ts`.
- Conventional Commits; this work ships as `fix:` / `chore:` / `docs:` exactly as given per task (release-please derives versions from them).
- Monetary values stay integer minor units (grosze / euro-cents / pence) in checkout/webhook code.
- No new dependencies. No schema changes — Task 5 only restores **already-applied** migration files into repo history; do NOT apply anything to any database.
- `.env*` files may be permission-blocked for tools in this environment. The `.env.example` step in Task 2 is best-effort: if the edit is denied, skip it, and say so in the task report (docs + AGENTS.md carry the documentation regardless).
- Verification commands: `npm run lint`, `npm run typecheck`, `npm run test` (Vitest), single file via `npx vitest run <path>`.
- Branching: Tasks 1–4 commit sequentially on branch `fix/stripe-stage-one` (created from `main`). Task 5 goes on its own branch `chore/restore-remote-migrations` (created from `main`) — the user prefers per-domain PRs; DB-history restoration is a different domain than the Stripe fixes.
- Do not push or open PRs unless the user asks after execution.

---



### Task 1: `releaseSale` convergence + crash-resume (the money/inventory fix)

**Files:**

- Modify: `src/app/api/stripe/webhook/route.ts` (the `releaseSale` dep implementation, currently lines 338–365)
- Modify: `src/lib/webhook.ts` (only the `releaseSale` doc comment on the `WebhookDeps` type, lines 8–16)
- Test: `src/app/api/stripe/webhook/route.test.ts` (extend `chain`/`makeSupabase`, update the `casFlipped` fixtures, add a new `describe` block)

**Interfaces:**

- Consumes: `releaseTargetStatus`, `releaseReservedPieces` from `@/lib/piece-release` (both already imported in `route.ts:16`); `cancelPrintFulfilment` from `@/server/fulfilment/cancel-print` (already imported).
- Produces: no new exports. `releaseSale(pi): Promise<boolean>` keeps its signature; `true` still means "pieces were (re)listed / inventory changed → caller revalidates".

**Design (read before coding).** The new `releaseSale` runs three compare-and-swap attempts in a deliberate order:

1. `pending→refunded` — refund/lost-dispute delivered before `payment_intent.succeeded`. Park the order `refunded` (so the late success cannot fulfil it — `markPaid`'s fallback, `createShipment`, `createOrderInvoice`, and conversions all gate on `status`) and free the still-`reserved` hold via `releaseReservedPieces`. No Prodigi cancel: fulfilment only enqueues for paid orders, and this order never reached paid.
2. `paid→refunded` — the normal path, unchanged (Prodigi cancel-or-alert, private-sale skip, relist `sold` rows).
3. already-`refunded` fallback — a prior attempt flipped the CAS but crashed before the piece release stuck; finish it (mirrors `releaseHold`'s fallback at `route.ts:311-337`). Releases rows still `'sold'` (paid-path crash) **or** `'reserved'` (pending-path crash), scoped by `order_id` so pieces since re-sold to another order are never touched.

Checking *pending before paid* closes the race with a concurrently-processing `payment_intent.succeeded`: if `markPaid` flips `pending→paid` between our two CAS attempts, the order was `pending` at attempt 1 — but then attempt 1 would have flipped it first (both are CAS on the same row). Every interleaving lands in exactly one branch.

Invariant that MUST survive: an order in `failed`/`expired` (e.g. the `markPaid` under-fulfillment auto-refund already set it `failed` and freed pieces) matches none of the three branches → `releaseSale` returns `false` and does nothing. The existing test "replayed charge.refunded … does NOT re-run the Prodigi handling" plus the `webhook.ts` doc comment encode this.

- [ ] **Step 1: Update the test harness and write the failing tests**

In `src/app/api/stripe/webhook/route.test.ts`:

1a. Replace the `chain` helper (currently lines 44–49) — adds `.in()` pass-through:

```ts
/** A chainable query stub whose `.eq()`/`.in()` return itself and whose terminal method resolves `result`. */
function chain(terminal: 'select' | 'maybeSingle', result: Result) {
  const b: Record<string, unknown> = { eq: () => b, in: () => b };
  b[terminal] = async () => result;
  return b;
}
```

1b. Replace `makeSupabase` (currently lines 57–80) — `ordersUpdate` may now be an array consumed per `orders.update()` call (releaseSale CASes `pending→refunded` before `paid→refunded`); a single value repeats for every call, so existing releaseHold tests are untouched:

```ts
/**
 * Supabase fake. `ordersUpdate` results are consumed per orders-UPDATE call
 * (releaseSale runs the pending→refunded CAS before the paid→refunded CAS);
 * a single value repeats for every call. `ordersSelect` is the fallback fetch
 * (releaseHold's failed-order lookup / releaseSale's refunded-order lookup);
 * `pieceUpdate` is the piece_state release. Records the piece_state update
 * payload so tests can assert the release actually ran (and with the right
 * target status).
 */
function makeSupabase(plan: { ordersUpdate: Result | Result[]; ordersSelect: Result; pieceUpdate: Result }) {
  const ordersUpdates = Array.isArray(plan.ordersUpdate) ? [...plan.ordersUpdate] : [plan.ordersUpdate];
  const calls = { pieceUpdatePayload: undefined as unknown, pieceUpdated: false };
  const supabase = {
    from(table: string) {
      if (table === 'orders') {
        return {
          update: () =>
            chain('select', ordersUpdates.length > 1 ? (ordersUpdates.shift() as Result) : ordersUpdates[0]),
          select: () => chain('maybeSingle', plan.ordersSelect),
        };
      }
      if (table === 'piece_state') {
        return {
          update: (payload: unknown) => {
            calls.pieceUpdatePayload = payload;
            calls.pieceUpdated = true;
            return chain('select', plan.pieceUpdate);
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { supabase, calls };
}
```

1c. In the `describe('webhook releaseSale → cancelPrintFulfilment (Finding 1)')` block, update the `casFlipped` fixture so the paid-CAS hit is the SECOND update result (first is the pending-CAS miss):

```ts
  const casFlipped = () =>
    makeSupabase({
      // update #1 = pending→refunded CAS (miss), update #2 = paid→refunded CAS (flip)
      ordersUpdate: [
        { data: [], error: null },
        { data: [{ id: 'o1', private_sale_id: null }], error: null },
      ],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [], error: null },
    });
```

(The other fixtures in that block — the "replayed" test's single `{ data: [], error: null }` and the F2 db-down test — stay as they are: a single value repeats for both CAS calls, and an error on the first CAS still throws.)

1d. Add a new `describe` block after the `Finding 1` block:

```ts
describe('webhook releaseSale convergence + crash-resume (stage-one audit)', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    vi.mocked(cancelPrintFulfilment).mockClear();
  });

  it('refund delivered before succeeded (order still pending): parks the order refunded and frees the reserved hold', async () => {
    const { supabase, calls } = makeSupabase({
      // update #1 = pending→refunded CAS flips; the paid CAS is never consulted
      ordersUpdate: [{ data: [{ id: 'o1', private_sale_id: null }], error: null }],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    // releaseReservedPieces freed the reserved hold and relisted it
    expect(calls.pieceUpdatePayload).toEqual({ status: 'available', reserved_until: null, order_id: null });
    // fulfilment never enqueues for a never-paid order — nothing to cancel
    expect(cancelPrintFulfilment).not.toHaveBeenCalled();
  });

  it('lost dispute before succeeded: same parking behaviour as a refund', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: [{ data: [{ id: 'o1', private_sale_id: null }], error: null }],
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(disputeClosedEventRequest('lost'));

    expect(res.status).toBe(200);
    expect(calls.pieceUpdated).toBe(true);
    expect(cancelPrintFulfilment).not.toHaveBeenCalled();
  });

  it('retry after a crash between the refunded-CAS and the relist: finishes the relist (no permanently stuck sold pieces)', async () => {
    const { supabase, calls } = makeSupabase({
      // both CAS attempts miss — the order is already refunded
      ordersUpdate: { data: [], error: null },
      // the refunded-order fallback fetch finds it
      ordersSelect: { data: { id: 'o1', private_sale_id: null }, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    // Without the fallback, the retry would return false here and the pieces
    // would stay 'sold' on a refunded order forever.
    expect(calls.pieceUpdated).toBe(true);
    expect(calls.pieceUpdatePayload).toEqual({ status: 'available', reserved_until: null, order_id: null });
  });

  it('replayed event on a fully-released refunded private-sale order: leaves the pieces sold (regression guard)', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: { data: [], error: null },
      ordersSelect: { data: { id: 'o1', private_sale_id: 'ps_1' }, error: null },
      pieceUpdate: { data: [], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(refundedEventRequest());

    expect(res.status).toBe(200);
    expect(calls.pieceUpdated).toBe(false);
  });
});
```

- [ ] **Step 2: Run the webhook route tests — expect the new/updated ones to FAIL**



Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts`

Expected: the two convergence tests and the crash-resume test FAIL (current code returns `false` without touching `piece_state`), and the updated `Finding 1` "full refund" / "lost dispute" tests FAIL (current code's first `orders.update` is the paid-CAS, which now receives the pending-miss fixture). The private-sale regression-guard test passes already — that is expected; it pins behaviour the new code must keep. `webhook releaseHold` and signature tests must still pass.

- [ ] **Step 3: Implement the new** `releaseSale`

In `src/app/api/stripe/webhook/route.ts`, replace the entire `releaseSale` property (currently lines 338–365) with:

```ts
    releaseSale: async (pi) => {
      // Convergence: three CAS attempts, in this order:
      //   1. pending→refunded — refund/lost dispute delivered BEFORE the
      //      succeeded event (e.g. a Dashboard refund during a webhook delivery
      //      delay). Park the order refunded so the late success can never
      //      fulfil it (markPaid's fallback, createShipment, invoicing and
      //      conversions all gate on status), and free the reserved hold.
      //   2. paid→refunded — the normal path.
      //   3. already-refunded — a prior attempt flipped the CAS but crashed
      //      before the piece release stuck; finish it (mirrors releaseHold's
      //      fallback — without this the Stripe retry hits an empty CAS and the
      //      pieces stay 'sold' on a refunded order forever).
      // Checking pending BEFORE paid closes the markPaid race: if markPaid
      // flips pending→paid between our two CAS attempts, the order was pending
      // at attempt 1 — but then attempt 1 would have flipped it first (both are
      // CAS on the same row). A failed/expired order (markPaid's own
      // under-fulfillment refund) matches none of the three and stays a no-op.
      const { data: pendingData, error: pendingErr } = await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id, private_sale_id');
      if (pendingErr) throw new Error(`releaseSale pending update failed: ${pendingErr.message}`);
      const pendingRows = pendingData as Array<{ id: string; private_sale_id: string | null }> | null;
      if (pendingRows && pendingRows.length > 0) {
        // No Prodigi cancel: fulfilment only enqueues for paid orders, and this
        // order never reached paid. Throws on failure → 5xx → the retry resumes
        // through the already-refunded fallback below.
        const freed = await releaseReservedPieces(supabase, pendingRows[0]);
        return freed.length > 0;
      }

      const { data, error: ordersErr } = await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('payment_intent_id', pi)
        .eq('status', 'paid')
        .select('id, private_sale_id');
      if (ordersErr) throw new Error(`releaseSale orders update failed: ${ordersErr.message}`);
      const rows = data as Array<{ id: string; private_sale_id: string | null }> | null;
      if (rows && rows.length > 0) {
        // Print orders: stop the Prodigi side (cancel or alert). Runs only when
        // the paid→refunded CAS actually flipped, so a replayed event can't
        // re-enter. Best-effort — never throws.
        await cancelPrintFulfilment(rows[0].id, env);
        // Private-sale pieces were sold privately (already hidden from the shop) and must
        // stay `sold` on refund — skip the relist write entirely. Normal refunds relist.
        if (releaseTargetStatus(rows[0]) === 'sold') return true;
        // Throw on a piece_state failure (don't return true): otherwise the caller
        // would revalidate inventory and advertise a piece as available while it is
        // still 'sold' in the DB. A 5xx makes Stripe retry, and the retry finishes
        // the relist through the already-refunded fallback below.
        const { error: pieceErr } = await supabase
          .from('piece_state')
          .update({ status: 'available', reserved_until: null, order_id: null })
          .eq('order_id', rows[0].id)
          .eq('status', 'sold');
        if (pieceErr) throw new Error(`releaseSale piece_state update failed: ${pieceErr.message}`);
        return true;
      }

      // Already refunded: finish any release a crashed prior attempt left
      // behind — rows still 'sold' (paid-path crash) or 'reserved'
      // (pending-path crash). Scoped by order_id, so pieces since re-sold to
      // another order are never touched. Private-sale pieces stay 'sold'.
      const { data: refunded, error: refundedErr } = await supabase
        .from('orders')
        .select('id, private_sale_id')
        .eq('payment_intent_id', pi)
        .eq('status', 'refunded')
        .maybeSingle();
      if (refundedErr) throw new Error(`releaseSale refunded lookup failed: ${refundedErr.message}`);
      const refundedOrder = refunded as { id: string; private_sale_id: string | null } | null;
      if (!refundedOrder || releaseTargetStatus(refundedOrder) === 'sold') return false;
      const { data: freedRows, error: resumeErr } = await supabase
        .from('piece_state')
        .update({ status: 'available', reserved_until: null, order_id: null })
        .eq('order_id', refundedOrder.id)
        .in('status', ['sold', 'reserved'])
        .select('product_id');
      if (resumeErr) throw new Error(`releaseSale resume release failed: ${resumeErr.message}`);
      return ((freedRows as Array<{ product_id: string }> | null) ?? []).length > 0;
    },
```

- [ ] **Step 4: Update the** `releaseSale` **doc comment on** `WebhookDeps`

In `src/lib/webhook.ts`, replace the comment block above `releaseSale` (currently lines 8–16) with:

```ts
  /**
   * Converge a fully-refunded / lost-dispute payment to `refunded` and return
   * its ceramic pieces to the shop, regardless of event delivery order: a paid
   * order is relisted; a still-pending order (refund observed before
   * `payment_intent.succeeded`) is parked `refunded` so the late success can
   * never fulfil it; an already-`refunded` order re-checks that the release
   * actually stuck and finishes it (crash-resume). Returns true if pieces were
   * (re)listed, false if nothing to do. The implementation MUST no-op for
   * `failed` orders: the markPaid under-fulfillment path issues its own refund
   * (and already sets the order `failed` + frees pieces), so the resulting
   * charge.refunded event must find nothing to do here.
   */
```

- [ ] **Step 5: Run the tests — expect PASS**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts src/lib/webhook.test.ts`
Expected: ALL pass (route tests including the four new ones and the updated Finding 1 block; the pure-handler `webhook.test.ts` is unaffected by design).

- [ ] **Step 6: Full verification**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git checkout -b fix/stripe-stage-one main
git add src/app/api/stripe/webhook/route.ts src/lib/webhook.ts src/app/api/stripe/webhook/route.test.ts docs/superpowers/plans/2026-07-18-stripe-stage-one-robustness.md
git commit -m "fix(webhook): converge releaseSale on out-of-order refund events and resume after partial failure"
```

---



### Task 2: Externalize the Stripe PMC id (apply unmerged `e8e8f91`)

**Files:**

- Modify: `src/app/api/checkout/route.ts`, `src/app/api/checkout/route.test.ts`, `cloudflare-env.d.ts` (all three via `git apply` of the authored diff)
- Modify: `AGENTS.md` (two one-line doc updates)
- Modify: `docs/cloudflare-deployment.md` (one bullet in "Runtime secrets")
- Modify (best-effort): `.env.example` (may be permission-blocked — skip if denied and report)

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: runtime secret name `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` (typed on `CloudflareEnv`); checkout returns `502 { error: 'stripe_failed' }` and releases its reservation when the secret is missing (fail-closed).

**Background:** Commit `e8e8f91` ("refactor(checkout): externalize Stripe PMC ID to env", 2026-07-16, branch `staging-development`) already implements this: removes `const STRIPE_PMC_ID = 'pmc_1QiwdYJ0KFK9lrjHUV93dONs'` (route.ts:23), reads `getCloudflareContext().env.STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` right before PaymentIntent creation, fails closed with `releaseOwnHold()` + 502, adds the field to `CloudflareEnv`, and updates the route test's `getCloudflareContext` mock. Verified: the merge-base of `main` and `e8e8f91` is `1ac2cff` (current main HEAD) and **only** `e8e8f91` touched these three files on that branch, so the diff applies cleanly. The commit also touches an unrelated `.hermes/plans/` file — the path-scoped diff below excludes it. Hermetic `@ci` Playwright specs are unaffected: `checkout-409.spec.ts` / `mixed-cart.spec.ts` exercise 4xx paths that return before the PMC read.

- [ ] **Step 1: Apply the three-file diff from** `e8e8f91`

```bash
git diff 1ac2cff e8e8f91 -- cloudflare-env.d.ts src/app/api/checkout/route.ts src/app/api/checkout/route.test.ts | git apply
git status   # expect exactly those 3 files modified
```

- [ ] **Step 2: Run the checkout route tests — expect PASS**

Run: `npx vitest run src/app/api/checkout/route.test.ts`
Expected: PASS (the commit updated the test to assert `payment_method_configuration: 'pmc_test_env'` from the mocked env).

- [ ] **Step 3: Update documentation**

3a. `AGENTS.md` — in the Checkout Flow section, replace the phrase:

`payment_method_configuration: STRIPE_PMC_ID` (`pmc_…`, hardcoded constant)

with:

`payment_method_configuration` from the `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` runtime secret (mode-specific; checkout fails closed with `502 stripe_failed` if unset)

3b. `AGENTS.md` — in Environment Variables → Runtime secrets, change the line

`- STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET`

to

`- STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`

3c. `docs/cloudflare-deployment.md` — in the "### Runtime secrets (`wrangler secret put`)" section (line ~210), add this bullet alongside the existing secret bullets:

```markdown
- `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` — Stripe payment-method configuration (`pmc_…`, Dashboard → Settings → Payment methods; enables BLIK/P24/Bizum/cards). Mode-specific — test and live ids differ. Checkout **fails closed** (502 `stripe_failed`) without it, so set the secret **before** deploying this code (`wrangler secret put STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`).
```

3d. Best-effort `.env.example` — append next to the other STRIPE entries:

```
# Stripe Payment Method Configuration id (Dashboard → Settings → Payment methods).
# Mode-specific (test vs live differ). Checkout FAILS CLOSED without it:
# POST /api/checkout returns 502 stripe_failed before creating a PaymentIntent.
STRIPE_PAYMENT_METHOD_CONFIGURATION_ID=pmc_...
```

If the edit is permission-denied, skip and note it in the task report.

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-env.d.ts src/app/api/checkout/route.ts src/app/api/checkout/route.test.ts AGENTS.md docs/cloudflare-deployment.md
git add .env.example   # only if Step 3d succeeded
git commit -m "fix(checkout): read Stripe payment-method configuration from env (fail closed)"
```

**⚠ Operator prerequisites (report to the user; NOT executable by the agent):** before this reaches production, run `wrangler secret put STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` with the **live** PMC id (the removed hardcoded value `pmc_1QiwdYJ0KFK9lrjHUV93dONs` is the live one to migrate); add the **test** PMC id to `.dev.vars` locally (also needed for `npm run test:e2e:edge`). Deploy order: secret first, code second.

---



### Task 3: Make swallowed invoice failures discoverable (`reconcile-orders --invoices`)

**Files:**

- Modify: `scripts/reconcile-orders.mjs`

**Interfaces:**

- Consumes: nothing from other tasks. References `docs/stripe-operations.md` (created in Task 4) in operator-facing strings — a doc pointer only, no hard dependency.
- Produces: a read-only `--invoices` flag, also included in the no-flag preview.

**Background:** `ensureInvoiced` swallows `createOrderInvoice` errors (Sentry-only) and the route 200s, so Stripe never redelivers — a missed invoice is invisible. `createOrderInvoice` (`src/lib/invoice.ts:41`) is fully idempotent and self-guards on `status === 'paid' && !invoiced_at && email`, so the **remedy** is a Workbench resend of the order's `payment_intent.succeeded` event — no new write path is needed, only discovery. This task follows the script's existing discover/run pattern (`discoverEmails`/`runEmails`).

- [ ] **Step 1: Add the flag, discovery, and report**

In `scripts/reconcile-orders.mjs`, make these edits:

1a. In `parseArgs` options (after `labels: { type: 'boolean' },`):

```js
        invoices: { type: 'boolean' },
```

1b. In the `args` object (after `labels: values.labels === true,`):

```js
    invoices: values.invoices === true,
```

1c. Update the no-action default block:

```js
  // No action flags → implicit dry-run preview
  const anyAction = args.emails || args.studio || args.buy || args.labels || args.invoices;
  if (!anyAction) {
    args.dryRun = true;
    args.emails = true;
    args.studio = true;
    args.buy = true;
    args.labels = true;
    args.invoices = true;
    args.previewOnly = true;
  }
```

1d. Add discovery after `discoverLabels`:

```js
async function discoverInvoices(supabase) {
  const { data, error } = await supabase
    .from('orders')
    .select('id, email, total, currency, paid_at, invoiced_at')
    .eq('status', 'paid')
    .is('invoiced_at', null)
    .not('email', 'is', null);
  if (error) throw new Error(`discover --invoices: ${error.message}`);
  return data ?? [];
}
```

1e. Add the report-only action handler after `runLabels`:

```js
/**
 * --invoices: report paid orders missing a Stripe invoice (read-only, always).
 * ensureInvoiced swallows failures after the webhook 200s, so a missed invoice
 * has no automatic retry — recovery is a Workbench resend of the order's
 * payment_intent.succeeded event (safe: every effect is idempotent/claimed).
 * See docs/stripe-operations.md.
 */
async function runInvoices(orders, { verbose }) {
  log(`\n── INVOICES (paid orders missing invoiced_at) ── ${orders.length} candidate(s)\n`);
  if (orders.length === 0) {
    ok('No paid orders missing an invoice.');
    return;
  }
  for (const order of orders) {
    const tag = `[${order.id.slice(0, 8)}]`;
    warn(
      `${tag} paid ${order.paid_at ?? '(no paid_at)'} · ${formatGrosze(order.total, order.currency)} · ` +
        `${redactEmail(order.email, verbose)} — no invoice recorded. ` +
        'Remedy: resend payment_intent.succeeded from Stripe Workbench (see docs/stripe-operations.md).',
    );
  }
}
```

1f. In `main()`, wire discovery — in the `explicitIds` branch add:

```js
    invoiceOrders = args.invoices ? paidOrders.filter((o) => !o.invoiced_at && o.email) : [];
```

and in the auto-discovery branch add:

```js
    invoiceOrders = args.invoices ? await discoverInvoices(supabase) : [];
```

(also add `invoiceOrders` to the `let emailOrders, studioOrders, buyOrders, labelOrders;` declaration).

1g. In the `previewOnly` summary block add:

```js
    log(`  --invoices: ${invoiceOrders.length} paid order(s) missing an invoice`);
```

1h. In the run-actions section add (after the `labels` block):

```js
  if (args.invoices) {
    await runInvoices(invoiceOrders, ctx);
  }
```

1i. In `printHelp()` options list add:

```
  --invoices       Report paid orders missing a Stripe invoice (read-only).
```

and in the header usage comment (top of file) add `[--invoices]` to the options line.

- [ ] **Step 2: Syntax check**

Run: `node --check scripts/reconcile-orders.mjs`
Expected: no output (clean parse).

- [ ] **Step 3: Live read-only verification (from the main checkout,** `.dev.vars` **present)**

Run: `node scripts/reconcile-orders.mjs --dry-run --invoices`
Expected: the banner prints, then `── INVOICES … ── N candidate(s)` with either `✓ No paid orders missing an invoice.` or warn-lines per candidate. No writes occur (the handler is read-only by construction). If `.dev.vars` is unavailable in the execution environment, run `node scripts/reconcile-orders.mjs` with no flags and confirm the help + preview path lists `--invoices`; report that the live check was skipped.

- [ ] **Step 4: Commit**

```bash
git add scripts/reconcile-orders.mjs
git commit -m "fix(reconcile): surface paid orders missing a Stripe invoice"
```

---



### Task 4: Stripe operations runbook (one page)

**Files:**

- Create: `docs/stripe-operations.md`
- Modify: `docs/orders-cli.md` (one "See also" line)

**Interfaces:**

- Consumes: behaviour shipped in Tasks 1–3 (replay safety, `--invoices`).
- Produces: the doc that Task 3's operator strings point to.

- [ ] **Step 1: Create** `docs/stripe-operations.md` **with exactly this content**

```markdown
# Stripe operations runbook

Operational recovery for the Stripe payment pipeline (checkout → webhook →
fulfilment). Monitoring lives in **Stripe Workbench** (event deliveries,
retries, resend) and **Sentry** (application errors) — this repo only adds
durable order state and the commands below. Owner: studio operator
(konrad.ciok@gmail.com).

## Correlate a payment to an order

Stripe PaymentIntent (`pi_…`) ↔ `orders.payment_intent_id` (one-to-one).

```bash
npm run orders -- list --limit 20          # recent orders + status
npm run orders -- show <order-id>          # full order: items, shipment, invoice, emails
```

In Workbench, search the `pi_…` id to see every event and its delivery status.
Never paste customer PII into shared logs; the CLIs redact emails by default.

## When a webhook delivery failed (non-2xx)

Stripe retries automatically for up to 3 days. If retries are exhausted or you
need it now: Workbench → the event → **Resend**.

**Resending** `payment_intent.succeeded` **is safe.** Every effect is guarded:
order flip is a CAS (`pending→paid`), customer/studio emails claim
`*_sent_at` columns before sending, invoicing checks `invoiced_at` + Stripe
idempotency keys, InPost shipment is guarded by `inpost_shipment_id`, Prodigi
enqueue by the job idempotency key, private-sale consumption by
`consumed_at IS NULL`, and conversions dedupe on `purchase-<pi>`.

**Resending** `charge.refunded` **/** `charge.dispute.closed` **is safe.** The release
converges regardless of order and resumes a partially-completed release
(pieces still `sold`/`reserved` on a `refunded` order are finished on replay);
a replay after full completion is a no-op.

## Recovery by symptom


| Symptom                                     | Detect                                                       | Fix                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Customer confirmation email missing         | `node scripts/reconcile-orders.mjs` (preview)                | `--emails`, or `npm run orders -- resend-confirmation --confirm <id>`                         |
| Invoice missing on a paid order             | `node scripts/reconcile-orders.mjs --dry-run --invoices`     | Workbench → resend that order's `payment_intent.succeeded`                                    |
| InPost shipment stuck / label missing       | reconcile preview (`--buy` / `--labels` sections)            | `--buy` then `--labels`, or `npm run orders -- create-shipment --confirm <id>`                |
| Prodigi print job stuck                     | `npm run print-fulfilment:check-jobs`; Cloudflare Queue DLQ  | re-run job per `docs/orders-cli.md`; escalate to Prodigi support with the `prodigi_orders` id |
| Order refunded but piece not back in shop   | `npm run orders -- show <id>` (pieces still `sold`)          | Workbench → resend the `charge.refunded` event (release resumes)                              |
| Payment succeeded but order still `pending` | Workbench shows failed `payment_intent.succeeded` deliveries | fix the cause (check Sentry), then resend the event                                           |


## Refunds

Issue refunds from the admin panel or `npm run orders -- refund --confirm <id>`
(full refunds only — a partial refund moves money without relisting). The
`charge.refunded` webhook performs the relist; do not hand-edit `piece_state`.

## Alerts — one-time setup checklist (operator, external)

- [ ] Workbench → Webhooks → the endpoint → enable delivery-failure
  ```
  notifications (test AND live mode).
  ```
- [ ] Workbench → keep the endpoint API version matched to the installed
  ```
  `stripe` package (see AGENTS.md "API-version ritual").
  ```
- [ ] Sentry → alert rule routing `stripe_webhook_*` messages and
  ```
  `createOrderInvoice`/email capture exceptions to the operator email.
  ```
- [ ] Cloudflare → notification on `prodigi-fulfilment` queue DLQ depth > 0.

## See also

- `docs/orders-cli.md` — order/inventory inspection + the four admin mutations
- `docs/prodigi-cli.md` — Prodigi sandbox debugging
- `scripts/reconcile-orders.mjs` — email/shipment/invoice backfill + discovery

```

- [ ] **Step 2: Cross-link from `docs/orders-cli.md`**

Add near the top (after the intro paragraph or in an existing "See also"-style location):

```markdown
Operational recovery flows (webhook replay, invoice/email backfill, alerts): see [stripe-operations.md](./stripe-operations.md).
```

- [ ] **Step 3: Commit**

```bash
git add docs/stripe-operations.md docs/orders-cli.md
git commit -m "docs(ops): add Stripe operations runbook"
```

---



### Task 5: Restore the two remote-applied migrations into repo history

**Files:**

- Create: `supabase/migrations/20260717120000_guarded_product_status.sql`
- Create: `supabase/migrations/20260717192143_harden_guarded_product_status.sql`

**Interfaces:** none (pure history restoration; content below was read from `supabase_migrations.schema_migrations` on project `wnlysejenowymjdxlnaq` during planning).

**⚠ Do NOT apply anything to any database.** These migrations are ALREADY applied remotely (that is the drift being fixed). This task only adds the files to git. Separate branch per the user's per-domain-PR preference.

- [ ] **Step 1: Create branch**

```bash
git checkout -b chore/restore-remote-migrations main
```

- [ ] **Step 2: Write** `supabase/migrations/20260717120000_guarded_product_status.sql`

```sql
-- Atomically transition product status, including the print-asset activation
-- gate. The prior application-side readiness read and later UPDATE admitted a
-- TOCTOU race with revision publication or emergency asset revocation.

create or replace function update_product_status_guarded(
  p_product_id  text,
  p_status      text,
  p_actor_email text default null
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_before  products%rowtype;
  v_after   products%rowtype;
  v_missing text[];
begin
  if p_status is null or p_status not in ('draft', 'active', 'hidden', 'archived') then
    raise 'invalid_product_status';
  end if;

  -- Serialises status changes with publish_print_asset_revision, which takes
  -- the same product-level lock before swapping assignments.
  select p.*
    into v_before
    from products p
   where p.id = p_product_id
   for update;
  if not found then
    raise 'product_not_found';
  end if;

  if p_status = 'active'
      and v_before.type = 'print'
      and v_before.status <> 'active' then
    -- Lock every input to the coverage calculation. A concurrent direct asset
    -- revoke either commits before this check (and is rejected here) or waits
    -- until activation commits, becoming a distinct emergency action after it.
    perform pv.id
      from product_variants pv
     where pv.product_id = p_product_id
       and pv.active
     for share;

    perform paa.asset_id
      from print_variant_asset_assignments paa
     where paa.product_id = p_product_id
     for share;

    perform pfa.id
      from print_fulfilment_assets pfa
      join print_variant_asset_assignments paa on paa.asset_id = pfa.id
     where paa.product_id = p_product_id
     for share of pfa;

    select coalesce(array_agg(pv.variant_key order by pv.variant_key), array[]::text[])
      into v_missing
      from product_variants pv
      left join print_variant_asset_assignments paa
        on paa.product_id = pv.product_id
       and paa.variant_key = pv.variant_key
      left join print_fulfilment_assets pfa on pfa.id = paa.asset_id
     where pv.product_id = p_product_id
       and pv.active
       and (
         paa.asset_id is null
         or pfa.id is null
         or pfa.product_id is distinct from p_product_id
         or pfa.status <> 'ready'
         or pv.print_area_width_px is null
         or pv.print_area_height_px is null
         or pfa.width_px is distinct from pv.print_area_width_px
         or pfa.height_px is distinct from pv.print_area_height_px
       );

    if coalesce(array_length(v_missing, 1), 0) > 0 then
      return jsonb_build_object(
        'ok', false,
        'error', 'print_assets_incomplete',
        'missing', to_jsonb(v_missing)
      );
    end if;
  end if;

  update products p
     set status = p_status,
         updated_at = now(),
         published_at = case
           when p_status = 'active' and p.published_at is null then now()
           else p.published_at
         end
   where p.id = p_product_id
   returning p.* into v_after;

  insert into catalog_audit_log (product_id, actor_email, action, before, after)
  values (
    p_product_id,
    nullif(p_actor_email, ''),
    'status:' || p_status,
    to_jsonb(v_before),
    to_jsonb(v_after)
  );

  return jsonb_build_object('ok', true, 'product', to_jsonb(v_after));
end;
$$;

-- Rollback (manual):
--   drop function if exists update_product_status_guarded(text, text, text);
```

- [ ] **Step 3: Write** `supabase/migrations/20260717192143_harden_guarded_product_status.sql`

```sql
-- Follow-up for an already-applied update_product_status_guarded migration:
-- lock every existing product variant before computing active coverage, and
-- restrict the RPC to the server-side service role. Repeating the full body via
-- CREATE OR REPLACE keeps the deployed database and fresh migration chains
-- equivalent without rewriting applied migration history.

create or replace function update_product_status_guarded(
  p_product_id  text,
  p_status      text,
  p_actor_email text default null
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_before  products%rowtype;
  v_after   products%rowtype;
  v_missing text[];
begin
  if p_status is null or p_status not in ('draft', 'active', 'hidden', 'archived') then
    raise 'invalid_product_status';
  end if;

  -- Serialises status changes with publish_print_asset_revision, which takes
  -- the same product-level lock before swapping assignments.
  select p.*
    into v_before
    from products p
   where p.id = p_product_id
   for update;
  if not found then
    raise 'product_not_found';
  end if;

  if p_status = 'active'
      and v_before.type = 'print'
      and v_before.status <> 'active' then
    -- Lock all existing variants, including inactive ones, so a concurrent
    -- inactive -> active transition cannot become a phantom after coverage is
    -- computed. Assignment and asset locks similarly serialize coverage input.
    perform pv.id
      from product_variants pv
     where pv.product_id = p_product_id
     for share;

    perform paa.asset_id
      from print_variant_asset_assignments paa
     where paa.product_id = p_product_id
     for share;

    perform pfa.id
      from print_fulfilment_assets pfa
      join print_variant_asset_assignments paa on paa.asset_id = pfa.id
     where paa.product_id = p_product_id
     for share of pfa;

    select coalesce(array_agg(pv.variant_key order by pv.variant_key), array[]::text[])
      into v_missing
      from product_variants pv
      left join print_variant_asset_assignments paa
        on paa.product_id = pv.product_id
       and paa.variant_key = pv.variant_key
      left join print_fulfilment_assets pfa on pfa.id = paa.asset_id
     where pv.product_id = p_product_id
       and pv.active
       and (
         paa.asset_id is null
         or pfa.id is null
         or pfa.product_id is distinct from p_product_id
         or pfa.status <> 'ready'
         or pv.print_area_width_px is null
         or pv.print_area_height_px is null
         or pfa.width_px is distinct from pv.print_area_width_px
         or pfa.height_px is distinct from pv.print_area_height_px
       );

    if coalesce(array_length(v_missing, 1), 0) > 0 then
      return jsonb_build_object(
        'ok', false,
        'error', 'print_assets_incomplete',
        'missing', to_jsonb(v_missing)
      );
    end if;
  end if;

  update products p
     set status = p_status,
         updated_at = now(),
         published_at = case
           when p_status = 'active' and p.published_at is null then now()
           else p.published_at
         end
   where p.id = p_product_id
   returning p.* into v_after;

  insert into catalog_audit_log (product_id, actor_email, action, before, after)
  values (
    p_product_id,
    nullif(p_actor_email, ''),
    'status:' || p_status,
    to_jsonb(v_before),
    to_jsonb(v_after)
  );

  return jsonb_build_object('ok', true, 'product', to_jsonb(v_after));
end;
$$;

-- PostgreSQL grants EXECUTE to PUBLIC for new functions by default. This RPC
-- accepts an audit actor supplied by the trusted admin server, so client roles
-- must never be able to invoke it directly.
revoke all on function public.update_product_status_guarded(text, text, text) from public;
revoke execute on function public.update_product_status_guarded(text, text, text) from anon, authenticated;
grant execute on function public.update_product_status_guarded(text, text, text) to service_role;

-- Rollback (manual): restore the prior function body and grants deliberately;
-- dropping this function would break the deployed admin status route.
```

- [ ] **Step 4: Verify drift is resolved (best-effort)**



Run: `npx supabase migration list --linked 2>&1 | tail -8`
Expected: `20260717120000` and `20260717192143` now show in BOTH local and remote columns. If the CLI is not authenticated in this environment, verify instead that `ls supabase/migrations/ | tail -3` shows the two new files after `20260715120000_fulfilment_jobs_alerted_at.sql`, and report that the linked check was skipped.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260717120000_guarded_product_status.sql supabase/migrations/20260717192143_harden_guarded_product_status.sql
git commit -m "chore(db): restore remote-applied guarded-product-status migrations"
```

---



## Verification (end-to-end)

1. On `fix/stripe-stage-one`: `npm run lint && npm run typecheck && npm run test` — all green; `npx vitest run src/app/api/stripe/webhook/route.test.ts` shows the new convergence/crash-resume tests passing.
2. `node --check scripts/reconcile-orders.mjs` clean; `node scripts/reconcile-orders.mjs --dry-run --invoices` runs read-only against prod and reports candidates (0 expected if all invoiced).
3. On `chore/restore-remote-migrations`: the two migration files exist with the exact remote versions/names; `npx supabase migration list --linked` (if authed) shows zero drift.
4. Not covered by automation (operator, post-merge): set `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` secret in prod **before** deploying Task 2's code; add it to `.dev.vars`; walk the runbook alert checklist (Workbench + Sentry + DLQ notifications).



## Out of scope (explicitly rejected from the audit)

`stripe_webhook_events` ledger table · lease/attempt event processor · `STRIPE_WEBHOOK_PROCESSOR_V2` shadow rollout · security-definer release RPC + pgTAP suite · Express Checkout experiment · Payment Links · Checkout Sessions migration · conversion-baseline/device-matrix/tabletop-drill programs.