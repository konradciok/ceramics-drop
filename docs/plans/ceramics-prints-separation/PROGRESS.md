# Ceramics ⇄ prints separation — execution progress

One entry per domain: decisions, files touched, tests, surprises. Consult before starting each domain.

## 01 — Refund lifecycle (DONE)

**Prodigi API shape (verified against https://www.prodigi.com/print-api/docs/reference/):**
- `GET /v4.0/orders/{id}/actions` → `{ outcome: "Ok", cancel: { isAvailable: "Yes"|"No" }, ... }`
- `POST /v4.0/orders/{id}/actions/cancel` → `{ outcome: "Cancelled"|"FailedToCancel"|"ActionNotAvailable", order: {...} }` — order stages are `InProgress`/`Complete`/`Cancelled`; cancel only available before fulfilment.
- Implementation checks `actions.cancel.isAvailable === 'Yes'` first (so `cancelOrder` is never called on a shipped order), then requires `outcome === 'Cancelled'`; any other outcome falls through to the alert.

**Decisions:**
- `prodigi_status_stage` keeps **raw Prodigi casing** (`'Cancelled'`, not `'cancelled'`) — matches processJob (`'InProgress'`) and the callback upsert convention.
- Alert idempotency across the two call sites (admin refund + webhook releaseSale) needed a claim column → migration `20260707120000_prodigi_orders_cancel_alert.sql` adds `prodigi_orders.cancel_alerted_at`; CAS-claimed before alerting (same pattern as `*_email_sent_at`). **Applied to production** (`20260707102056` via Supabase MCP, 2026-07-07).
- Studio alert email is Polish-only, matching the existing studio email convention (label/new-order emails).
- Helper never throws (Sentry captures every failure path) so a Prodigi hiccup can't 5xx the refund webhook into a retry loop.

**Surprise:** `process-job.ts` already had the "order not paid → failed_action_required" guard (plan step 4) — it predates this work. Only strengthened its test to assert `postOrder` is never called.

**Files:** `src/server/prodigi/types.ts` (+2 response types), `src/server/prodigi/client.ts` (+`getOrderActions`, `cancelOrder`), `src/server/fulfilment/cancel-print.ts` (new helper), `src/lib/email.ts` (+`buildPrintRefundAlertEmail`/`emailPrintRefundAlertToStudio`), `src/app/api/stripe/webhook/route.ts` (releaseSale wire-in after CAS), `src/app/api/admin/refund/route.ts` (wire-in after refund create), migration above.

**Tests:** `src/server/fulfilment/cancel-print.test.ts` (10 new), webhook `route.test.ts` (+5: full refund / replay / partial / dispute lost / dispute won), `process-job.test.ts` (+1 assertion). Full suite 637 green, lint clean, build green.

**Note:** a stale `.next` dir in the worktree made `next build` fail with a workStore invariant — `rm -rf .next` fixed it; not related to any code change.
