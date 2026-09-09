# Gift-card balance rollout — work in progress

This supplements the implementation plan dated 2026-09-09. It is not a production completion receipt. All migrations and code are currently local.

## State and invariants

`gift_cards` holds currency and monetary balance. `gift_card_holds` subtracts outstanding reservations from spendable balance. `gift_card_ledger` records issuance, spending, refunds, revocation and migration. Codes and customer data must never enter logs or analytics.

The order value remains `total`. `gift_card_amount` is payment, not discount; generated `cash_amount` is the difference. Full balance payment has no PaymentIntent. `settle_gift_card` commits debit, journal, paid status and ceramic sale together. A pending or unknown Stripe outcome keeps the hold; cancellation/compensation must be confirmed before `abort_balance_order` releases it.

`checkout_payment_modes` binds a checkout UUID to cash or balance before either path can create a PaymentIntent. Retries must keep their UUID, including after ambiguous failures. Do not remove a mode row for an existing order.

## Rollout order

1. Complete the plan's remaining validation and review. Verify the minimum top-up against the actual Stripe settlement currencies; current constants are same-currency Stripe minimums.
2. Inspect existing gift-card purchases and promo redemptions. The cutover is conservative: spent codes receive zero, revoked codes remain revoked, pending redemptions or mismatched denominations require review. Preserve the original history.
3. Apply migrations in timestamp order from `20260909120000` through `20260909170000`. Spending is disabled by default. The legacy promo guard prevents any old worker from reactivating a gift code; the new recovery sweep can issue a card for a paid purchase interrupted during deployment.
4. Deploy the reviewed worker and verify migration compatibility, scheduled recovery, webhook handling and receipt access. Match the approved content in every locale and publish CMS only after checking its current versions.
5. Enable new spending through the single `gift_card_settings` row only after these checks. Ending the old ceramic drop is a separate explicit rollout operation in the approved plan.

## Recovery

The 15-minute scheduled handler retries paid orders missing `paid_processing_completed_at`, old pending balance payments, pending refunds, and full-refund fulfilment cleanup. Every row failure is separately reported to Sentry. A failed row does not prevent other rows from progressing.

When PaymentIntent creation may have succeeded but its id was not saved, retries reuse `balance_pi_<order-id>` within 23 hours. Beyond that, recovery searches Stripe for the original order metadata. Missing or conflicting results retain the hold and require manual review; never create a replacement charge on a guess.

The paid-order processor claims a five-minute lease. Invoice creation, fulfilment and each email have independent idempotency protections. A failed step leaves the order retryable. The invoice id is stored before finalization; an invoice search recovers a create whose DB write was lost.

## Refunds

Existing full-refund UI/CLI actions route balance-funded orders to the balance ledger. The stable operation UUID is the order UUID; the RPC computes the remaining refundable amount. Partial refunds use authenticated `POST /api/admin/balance-refund` with `{ orderId, refundId, amount }`; amount is integer minor units and refundId must survive retries. A pending Stripe refund retains a pending ledger entry until confirmed.

Current confirmed Stripe refunds are reconciled before fulfilment. Cumulative reconciliation prevents duplicates and out-of-order events from crediting twice. Partial refunds do not relist ceramic pieces. Full refunds also stop or escalate print fulfilment. A used gift-card purchase cannot be refunded automatically; an external refund of such a purchase places the card in review and raises an alert.

Lost disputes for balance-funded payments currently require manual review. Do not pass them through the legacy cash-only full-order relisting logic.

## Rollback

Set `gift_card_settings.spending_enabled=false` to pause new holds. Existing holds can still settle, release or refund; history remains available. Keep the balance-capable worker and recovery handlers for existing orders. Never roll back to issuing or accepting legacy single-use promo codes for a balance-bearing card.

## Verification

Unit and browser tests run through normal npm/Vitest/Playwright commands. Real SQL tests use `scripts/test-gift-card-postgres.mjs` with an explicitly supplied local embedded PostgreSQL module and a fresh local data directory. This script does not accept a database URL and must never target production.
