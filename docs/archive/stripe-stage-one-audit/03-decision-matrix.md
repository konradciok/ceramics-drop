# Decision matrix

Scores use 1 (low) to 5 (high). “Impact” in the compact matrix is the highest of business, conversion, and operational impact; the detailed scorecard supplies all required dimensions. Classifications use exactly the requested vocabulary.

## Summary matrix

| Suggestion | Current state | Evidence | Gap | Impact | Effort | Risk | Classification | Rationale |
| ---------- | ------------- | -------- | --- | -----: | -----: | ---: | -------------- | --------- |
| Express Checkout Element | Not mounted; Payment Element can already show eligible wallets | `CheckoutForm.tsx`; Stripe Payment Element and Express docs; connected test domain list empty | Wallet prominence is unmeasured; domain/config readiness unverified; must preserve pre-payment delivery validation | 3 | 3 | 3 | **Implement a reduced version** | After config/domain work, add only a flagged post-validation control above Payment Element with full fallback and measurement. Do not let it collect/override InPost or print delivery. |
| Stripe Link | Payment Element integration supports Link by default when the selected configuration/account/device is eligible | `CheckoutForm.tsx`; Link docs; connected default test configuration showed Link active | Live configuration unverified; custom address form is not Link-autofilled | 2 | 1 | 1 | **Keep current implementation** | Do not add a duplicate Link flow. Verify live configuration and copy; consider Address Element only as a separate future checkout-form project. |
| Payment Links — unique/private-sale ceramics | No Payment Links; private sales use an internal token and atomic reservation RPC | `private-sale.ts`, checkout route, reservation migrations; Payment Links create Checkout Sessions | No shared inventory lock, internal order ingestion, InPost selection, or existing webhook handler | 5 | 5 | 5 | **Skip** | A completed-session limit cannot prevent a race with the storefront. The existing private-sale checkout is the correct channel. |
| Payment Links — workshops/deposits/custom/B2B | No explicit compatible internal order type or Session webhook pipeline | No Checkout Session handlers; `orders.payment_intent_id` and current fulfillment assumptions | Product model, fulfillment, payment schedule, accounting, customer history, analytics, and webhook mapping undefined | 3 | 4 | 4 | **Defer** | Potential value exists, but not as a Stage 1 shortcut. Define the internal commercial model first. |
| Payment Links — prints | Existing print checkout validates address, shipping, asset readiness, variant, and Prodigi job contract | print pricing/assets/checkout and fulfillment modules | Generic link bypasses those validations and current PI webhook | 3 | 5 | 5 | **Skip** | It would create a second print-order pipeline and fulfillment ambiguity. |
| Stripe-managed automatic receipts | Custom order confirmation plus Stripe Invoice email; checkout omits `receipt_email` | webhook/order email and `invoice.ts`; Stripe receipts docs | Live Dashboard receipt setting unverified; artifact ownership not documented in one place | 2 | 1 | 2 | **Keep current implementation** | Avoid an additional generic receipt unless accounting/legal decides it is required. Document payment receipt vs confirmation vs invoice/fiscal document. |
| Workbench and operational monitoring | Workers observability, Sentry, Queue DLQ, CLIs/reconciler exist; no complete Stripe response runbook found | `wrangler.jsonc`, Sentry config, scripts/docs; Workbench docs | Alert owner/thresholds, replay decision tree, swallowed-effect recovery and production checks | 5 | 1 | 1 | **Implement now** | Configure Stripe-native alerts and create a concise operational runbook; do not duplicate Workbench in code. |
| Signature verification/raw request | Correct raw text and `constructEventAsync` | `src/app/api/stripe/webhook/route.ts`; webhook signature docs | None demonstrated | 5 | 1 | 1 | **Already implemented — no action** | Preserve this contract and keep route tests. |
| Duplicate-event protection | Many effects are locally guarded, but no Stripe event processing record | `webhook.ts`, order/email/invoice/fulfillment idempotency; no Stripe use of `webhook_events` | No durable per-event attempt/lease/completion/error history | 5 | 3 | 3 | **Fix current implementation** | Add a resumable event/effect processing contract; do not mark an event done before all required durable effects converge. |
| Out-of-order refund/dispute/success | Refund/dispute only releases when the order is already paid | `releaseSale()` and success handler in `webhook.ts`; Stripe ordering docs | Refund/lost dispute before success is acknowledged as a no-op; later success may fulfill | 5 | 4 | 5 | **Fix current implementation** | State must converge from Stripe's current object/payment state regardless of delivery order. This is the highest-risk defect. |
| Transactional sale release | Order becomes refunded before ceramic rows are released in a separate request | `releaseSale()` and Supabase writes | Retry cannot resume piece release after the paid→refunded CAS has committed | 5 | 3 | 4 | **Fix current implementation** | Use one database RPC or an explicitly retry-resumable transition/outbox. |
| Asynchronous payment and trusted fulfillment | Payment Element redirects; webhook success owns paid/fulfillment; return page is informational | `CheckoutForm.tsx`, `PaymentReturn.tsx`, `webhook.ts` | Event-order reconciliation remains; current configured method behavior should be contract-tested | 5 | 2 | 3 | **Keep current implementation** | Core source-of-truth choice is correct. Fix convergence, not the UI return page. |
| Webhook replay/recovery | Stripe retries thrown fulfillment failures; CLIs and reconciliation exist; invoice/email errors may return 200 | `webhook.ts`, orders/reconcile scripts | No single documented replay/reconcile procedure or event correlation ledger | 5 | 2 | 2 | **Implement now** | Operationally connect Workbench, Sentry, internal order state, safe commands, and verification. |
| Checkout Sessions architecture | Not used; deeply integrated Payment Intent model | checkout route, `CheckoutForm.tsx`, schema and tests; Stripe comparison docs | Some managed Checkout features absent, but no material requirement depends on them | 2 | 5 | 5 | **Keep current implementation** | Migration would disturb inventory, shipping, fulfillment, analytics, and idempotency for weak demonstrated value. |
| Payment-method configuration portability | Hard-coded PMC; connected test account does not contain it | checkout route and read-only connected test inspection | Test/live/account-specific configuration cannot be safely shared | 4 | 1 | 2 | **Fix current implementation** | Use a required/validated runtime variable and document per-mode setup before wallet rollout. |

## Detailed scorecard

| Suggestion | Business | Conversion | Operational | Effort | Regression risk | Dependency complexity | Confidence |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Express Checkout Element | 3 | 3 | 1 | 3 | 3 | 3 | Medium |
| Stripe Link | 2 | 2 | 1 | 1 | 1 | 2 | High for code; medium for live config |
| Payment Links — unique/private-sale ceramics | 1 | 2 | 1 | 5 | 5 | 5 | High |
| Payment Links — workshops/deposits/custom/B2B | 3 | 3 | 2 | 4 | 4 | 5 | Medium |
| Payment Links — prints | 1 | 2 | 1 | 5 | 5 | 5 | High |
| Stripe-managed automatic receipts | 2 | 1 | 2 | 1 | 2 | 2 | Medium because live setting is unknown |
| Workbench and operational monitoring | 3 | 1 | 5 | 1 | 1 | 1 | High |
| Signature verification/raw request | 5 | 1 | 5 | 1 | 1 | 1 | High |
| Duplicate-event protection | 5 | 1 | 5 | 3 | 3 | 3 | High |
| Out-of-order refund/dispute/success | 5 | 1 | 5 | 4 | 5 | 4 | High |
| Transactional sale release | 5 | 1 | 5 | 3 | 4 | 3 | High |
| Asynchronous payment/trusted fulfillment | 5 | 2 | 5 | 2 | 3 | 3 | High |
| Webhook replay/recovery | 4 | 1 | 5 | 2 | 2 | 2 | High |
| Checkout Sessions architecture | 2 | 2 | 2 | 5 | 5 | 4 | High |
| Payment-method configuration portability | 3 | 3 | 4 | 1 | 2 | 2 | High for test evidence; medium for live impact |

## Classification notes

- “Already implemented — no action” for signature verification means preserve/test it, not remove coverage.
- “Keep current implementation” for Link does not assert that live Link is enabled. It means the Payment Element integration path is correct; the remaining action is configuration verification rather than a new Link implementation.
- Express Checkout is deliberately reduced: configuration and measurement are prerequisites, and its placement must not bypass required store data.
- Payment Links are split by use case because one classification would hide the decisive inventory distinction. They are skipped for current sellable products and deferred only for future commercial models that do not yet exist.
