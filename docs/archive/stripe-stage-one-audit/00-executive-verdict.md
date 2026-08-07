# Stripe Stage 1 audit: executive verdict

Audit date: 2026-07-18  
Repository revision: `1ac2cff` (`package.json` version `0.7.1`)

## Verdict

The checkout is materially more mature than the proposed Stage 1 list implies. It is a custom Stripe Payment Intents integration using Payment Element, backed by an atomic Supabase reservation RPC, server-authoritative prices, a stable checkout-attempt identifier, webhook-driven fulfillment, compensating refunds when a late payment can no longer acquire a one-of-one item, and separate ceramic and print fulfillment paths. The return page reports status and emits browser analytics; it is not the fulfillment authority. Keeping this architecture is preferable to migrating to Checkout Sessions now.

The most important work is not adding more Stripe surfaces. It is closing two recovery holes in the webhook state machine and establishing an operational response path. A refund or lost-dispute event that arrives before `payment_intent.succeeded` is currently acknowledged while the order is still pending; a later success can then mark and fulfill it as paid. Separately, `releaseSale()` changes an order to `refunded` before it releases ceramic rows in a second database request. If that second request fails, the retry sees an already-refunded order and cannot finish the release. Stripe documents webhook delivery as unordered and at-least-once, so both cases must be designed for rather than treated as theoretical.

Express Checkout can provide incremental value, but only as a reduced, measured addition after the store's payment-method configuration and payment-method domains are verified in the live account. Link is already available through Payment Element when enabled in the applicable Stripe payment-method configuration; this checkout does not use Stripe's Address Element, so Link does not currently autofill the store's custom delivery form. Payment Links should not be used for unique ceramics: their completed-session limits do not create a shared reservation lock with `piece_state`, and the existing webhook does not convert Checkout Sessions into internal orders.

## Three highest-value actions

1. **Repair webhook convergence and atomicity.** Make refund/dispute handling converge correctly regardless of event order, make the order transition and ceramic release atomic or retry-resumable, and record Stripe event processing state without mistaking “event received” for “all effects completed.” This protects money, inventory, and fulfillment.
2. **Add an operational recovery contract.** Configure Stripe Workbench webhook/API health alerts, name an owner, and document replay, reconciliation, invoice/email recovery, shipment/Prodigi inspection, and escalation. Keep Stripe's monitoring in Stripe; add repository state only where it makes recovery deterministic.
3. **Fix and verify payment configuration before adding UI.** Replace the current environment-specific hard-coded payment-method configuration with a validated runtime setting, register every live/test payment domain, verify Apple Pay/Google Pay/Link in the intended account and browsers, then optionally run a feature-flagged Express Checkout experiment above Payment Element after the store has collected and validated delivery data.

## Skip or defer

- **Skip Payment Links for one-of-one ceramics and private-sale ceramics.** The existing private-sale token and reservation RPC are safer and preserve order, stock, fulfillment, and analytics consistency.
- **Defer Payment Links for workshops, deposits, custom work, and B2B.** They may be useful later, but only after those concepts have explicit internal order types, fulfillment/accounting ownership, webhook mapping, and reporting rules. Do not introduce a second unintegrated order pipeline in Stage 1.
- **Keep Payment Intents and Payment Element.** A Checkout Sessions migration has high coupling and regression cost with no demonstrated material benefit for this store.
- **Do not enable a second generic Stripe receipt email by default.** The application already sends an order confirmation and creates/sends a Stripe Invoice. A payment receipt, order confirmation, invoice, and fiscal/tax document are different artifacts.
- **Do not build a custom Stripe-dashboard clone.** Workbench already provides event delivery, request/error, resend, and health surfaces. Repository work should focus on durable state and recovery procedures.

## Major risks

- **Highest risk:** unordered refund/dispute and success events can converge to an incorrect paid/fulfilled state.
- The refund transition and one-of-one inventory release are not one transaction and are not currently retry-resumable after the order becomes `refunded`.
- There is no Stripe event-processing ledger. Existing side effects have useful local idempotency guards, but operators cannot see a durable per-event processing history or safely resume a partially completed event as one unit.
- Invoice and customer-email failures are intentionally swallowed after capture and rely on Sentry/manual reconciliation; no Stripe-specific recovery runbook was found.
- The connected local **test-mode** account had no registered payment-method domains. Its default payment-method configuration had Apple Pay and Link active, Google Pay unavailable, and the configuration ID hard-coded in the repository was not present in that test account. Live-mode settings, automatic-receipt settings, and Apple Pay domain readiness could not be verified.
- The linked Supabase project has two remote-only migrations not present in the repository. They concern guarded product-status changes, not Stripe, but new database work should not proceed until migration history is reconciled.

## Should implementation proceed now?

Yes, but only with the small robustness and operations scope defined in `04-recommended-scope.md`. Do not begin a Checkout Sessions migration or general Payment Links rollout. Treat Express Checkout as an optional, separately measurable conversion experiment after configuration prerequisites are proven. No production implementation is included in this audit.

## Evidence limitations

The requested Supabase MCP server was not installed or authenticated in this environment. Access restoration was attempted, including MCP discovery and the linked project path. The live audit therefore used the linked Supabase CLI migration history plus read-only service-role Data API aggregates, without printing credentials or customer data. A complete live catalog/schema dump was not possible because the CLI's database dump path required unavailable Docker. Live rows and migration drift were verified, but live RLS policy definitions, triggers, indexes, and every constraint were reconciled from applied migration history rather than independently introspected through MCP. This is a material limitation and is called out throughout the audit.
