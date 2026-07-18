# Risks and open questions

## Blockers before implementation

1. **Supabase MCP is unavailable.** The requested source-of-truth audit could not be completed through MCP. Linked CLI migration history and read-only Data API aggregates were used as a documented fallback, but direct live introspection of policies, triggers, constraints, indexes, and functions must be restored before approving a database migration.
2. **Migration history is drifted.** The linked project contains remote-only migrations `20260717120000_guarded_product_status.sql` and `20260717192143_harden_guarded_product_status.sql`. They must be reviewed and committed before new Stripe migrations.
3. **Live Stripe configuration was not accessible.** Only the connected local test-mode credential could be inspected. Live payment-method configuration, domain registration, receipts, Workbench alerts, and endpoint version/event set require Dashboard verification.
4. **No operator/alert recipient is named in repository evidence.** Monitoring without ownership does not reduce recovery time.
5. **Product/accounting decisions for receipts, workshops, deposits, custom work, and B2B are undefined.** Payment Links cannot be safely designed before these decisions.

## Highest-severity correctness risks

### Out-of-order refund/dispute and success

Fact: Stripe does not guarantee event ordering. Current `releaseSale()` acts only after an order is paid. A refund or lost dispute received first can be acknowledged as a no-op, followed by a success that marks paid and begins fulfillment.

Required decision: choose the authoritative terminal-payment representation and reconciliation algorithm. Clarify how an already-shipped order differs operationally from a refund observed before shipment.

### Split refunded-order and inventory release writes

Fact: the order status and `piece_state` release occur in separate Supabase calls. A retry after the first succeeds cannot currently resume the second because the paid-to-refunded guard no longer matches.

Required decision: transaction/RPC versus an explicit intermediate state/reconciler. RPC is simpler for ceramics; print cancellation remains an external saga.

### Partial external side effects

Fact: the database cannot transact with Stripe, Resend, InPost, Meta/GA4, or Prodigi. Idempotency keys and claims mitigate duplicates, but each effect needs an explicit resume rule. “Exactly once” is not a valid transport assumption.

Open questions:

- Which effects are required before an event is considered complete?
- Which failures should return 5xx to Stripe versus be acknowledged and sent to an independent reconciler?
- How long are processing records retained, and who clears terminal failures?
- Should conversions be retried, and for how long, without delaying fulfillment?

## Inventory and order edge cases

- When a full refund occurs after an item has shipped, should a unique ceramic immediately become `available`, or only after a physical return is received? Current code relists on full refund/lost dispute. That business rule may expose stock not physically in the studio and should be confirmed before preserving it in a new atomic RPC.
- A lost dispute does not necessarily mean the physical item returned. Should its inventory transition differ from a voluntary full refund?
- What is the policy when a late succeeded payment is automatically refunded but the refund itself fails or remains pending?
- Should an expired pending order that later succeeds have a distinct terminal reason for customer support/reporting?
- Are manual bank/offline payments or admin-created orders expected to share `orders.payment_intent_id NOT NULL`? This matters for future B2B/deposits, not current checkout.
- Current live aggregates show 120 of 126 piece-state rows marked showroom and 120 sold. Confirm that showroom semantics are intentional and not an audit-data interpretation issue before writing broad inventory repair queries.
- Full refunds relist while partial refunds do not. Confirm this is the intended inventory policy for mixed/multi-ceramic orders and damaged-item partial refunds.

## Express Checkout and wallet questions

Facts:

- Payment Element can already show eligible wallets and Link.
- The connected test-mode domain registry was empty.
- The connected default test payment-method configuration had Apple Pay/Link active and Google Pay unavailable; the repository's hard-coded PMC did not exist in that account.
- The custom checkout form—not Stripe—collects locker, address, delivery method, and consent before the PaymentIntent exists.

Open questions:

- What do live funnel data show by browser/device and payment method? Is payment-form completion actually a bottleneck?
- Which exact live/test domains and subdomains render checkout?
- Is the Stripe account eligible/configured for Google Pay in the required countries/currencies?
- Has Apple Pay domain ownership been registered and verified in both modes?
- Should Express Checkout be visually prominent for pickup as well as shipped orders?
- What analytics event/dimension will distinguish Express from standard Payment Element without fragmenting the shared purchase event ID?
- What experiment threshold justifies keeping the extra surface?

Risk: placing Express before `/api/checkout` or treating wallet shipping as authoritative would bypass required validation. The approved placement must remain after application delivery validation and reservation.

## Link questions

- Is Link enabled on the actual live payment-method configuration?
- Does the store want Link branding/copy exposed in every locale?
- Is payment-only convenience sufficient, or is address autofill a product requirement? The latter is a separate Address Element/form project.
- How should a Link email interact with the application's contact email if they differ? The application email must remain the order-contact source unless product/legal explicitly changes it.

Risk: promising “saved delivery details” when only payment details are integrated would mislead customers.

## Payment Links questions

For current ceramics and prints, the answer is no. Before future workshop/deposit/custom/B2B use:

- What internal entity is sold: seat, service, commission milestone, deposit, invoice, or product?
- Is capacity unique/limited, and when is it reserved?
- What happens on an abandoned Session or delayed payment?
- Who owns shipping/attendance/customer custom fields?
- Does a deposit create an order balance and later PaymentIntent/Invoice?
- How are refunds/cancellations and customer history represented?
- Which analytics channel/source should DM/Instagram links record?
- Who may create/disable links and prevent stale offers?
- Can a small internal admin-created order plus normal PaymentIntent be safer and more consistent?

Security risk: metadata and URL reference IDs are identifiers, not authorization or an inventory lock. Never trust them as product/price truth.

## Receipts, invoices, and fiscal documents

Unknowns:

- Are automatic successful-payment receipts enabled in the live Stripe Dashboard?
- Do current customers receive both the custom confirmation and Stripe Invoice, and has duplicate/confusing communication been observed?
- Is the Stripe-created Invoice intended as the commercial invoice for all locales/currencies?
- What separate fiscal receipt/invoice obligations apply to the seller and sale location? This requires qualified accounting/legal review.
- Which email should be the authoritative payment confirmation when a payment is delayed?

Risk: enabling automatic receipts without reviewing the live email sequence can create duplicate/conflicting messages. A Stripe receipt must not be represented as proof of tax/fiscal compliance.

Tax automation and Canary Islands handling remain outside Stage 1 unless accounting identifies a blocking dependency.

## Webhook and API version questions

- Verify the live endpoint API version matches installed stripe-node's `2026-05-27.dahlia`; only test mode was observed.
- Decide whether to set `apiVersion` explicitly in code. Explicitness can clarify the contract, but package types and endpoint snapshots must still move together. Omitting it currently uses the SDK release version, not account default.
- Who performs the package-bump ritual and updates endpoint versions/fixtures?
- Is a single webhook endpoint sufficient for test/live operational isolation, and are secrets rotated/documented?
- What event-retention period is appropriate for the new ledger under privacy/security requirements?
- Should Workbench resend be the primary replay path or should the internal reconciler retrieve the object and converge without event replay?

## Fulfillment and communication recovery

- Invoice and email errors can be captured while the webhook returns 200. What alert SLO and retry schedule are acceptable?
- Which nonretryable InPost errors require manual action, cancellation, or customer contact?
- Who monitors the Cloudflare fulfillment DLQ and how quickly?
- What happens if the Queue send fails after the database job exists? Existing design can reconcile, but the operator path must be exercised.
- Can `scripts/reconcile-orders.mjs` safely target a single order/event in production, and does every mutation require explicit confirmation/dry-run?
- What evidence must an operator capture after a replay to prove no duplicate external fulfillment?

## Monitoring and privacy risks

- Workbench can see Stripe delivery/API data but not application failures after a 2xx response. Sentry/internal reconciliation must cover those.
- Avoid logging raw webhook bodies, signatures, client secrets, full PaymentIntent/charge objects, emails, addresses, phone numbers, or payment details.
- Event/error tables should use bounded safe codes/messages. Full stack traces belong in access-controlled error monitoring with retention rules.
- Alerts must be actionable; excessive low-value alerts will be ignored. Start with delivery failures, processing terminal failures/stuck leases, fulfillment/DLQ, and sustained API errors.
- Service-role-only event/RPC access must be verified live, not assumed from migrations.

## Assumptions made by this audit

- The audited checkout code at revision `1ac2cff` represents production intent, although a later/config-related commit exists on another branch.
- The linked Supabase project is the relevant live project. This was inferred from repository linkage because MCP project identity was unavailable.
- Read-only test Stripe configuration is not treated as live configuration evidence.
- Existing custom confirmation and Stripe Invoice emails are intentional.
- Current one-of-one ceramics must never be sold through an alternate path lacking the shared reservation RPC.
- Prints continue to require the existing asset-readiness and Prodigi pipeline.
- No implementation authorization is implied by approval to read connected configuration/data.

## Decisions required from the reviewer

1. Approve webhook convergence + atomic release as the first engineering work?
2. Confirm inventory policy after full refund/lost dispute: relist immediately or wait for physical return?
3. Approve a dedicated Stripe event-processing table and retention policy?
4. Name the payment/fulfillment operator and alert recipients.
5. Confirm customer-email ownership: custom confirmation + Stripe Invoice, automatic receipt off unless required?
6. Approve configuration portability/domain registration before any Express work?
7. Is an Express Checkout experiment worth running after baseline, and what is its success metric?
8. Confirm Payment Links are prohibited for current ceramics/prints and deferred for undefined future order types.
9. Restore Supabase MCP/live schema access and live Stripe Dashboard read access before implementation design is finalized.
