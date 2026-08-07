# Stripe documentation review

All sources below are official Stripe documentation accessed on **2026-07-18**. Conclusions are constrained to this repository's Payment Intents/Payment Element design and the installed Stripe versions.

## Checkout Sessions versus Payment Intents

Sources:

- [Checkout Sessions and Payment Intents comparison](https://docs.stripe.com/payments/checkout-sessions-and-payment-intents-comparison)
- [Build an advanced payments integration](https://docs.stripe.com/payments/advanced)
- [Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment)

Stripe recommends Checkout Sessions for most new integrations because Sessions own more checkout lifecycle and expose more managed features. Stripe also describes Payment Intents as the lower-level choice when an application needs to own checkout state and logic.

That general recommendation does not justify migration here. This store already owns pre-payment InPost locker selection, custom delivery validation, currency rules, one-of-one Supabase reservation, private-sale tokens, separate print asset validation/fulfillment, stable attempt IDs, custom order persistence, and server conversions. Checkout Sessions would not remove the need for the application's inventory transaction or fulfillment pipeline. It would change the primary Stripe object/event contract, order association, return path, tests, and operational procedures. No Stage 1 business requirement was found that requires Sessions.

If Checkout Sessions were adopted later, fulfillment must still be webhook-based and idempotent, including `checkout.session.completed` and delayed-payment success. A landing page is not a fulfillment authority.

## Payment Element, wallets, and Link

Sources:

- [Payment Element](https://docs.stripe.com/payments/payment-element)
- [Link with Payment Element](https://docs.stripe.com/payments/link/payment-element-link)
- [Link overview](https://docs.stripe.com/payments/link)
- [Link integrations](https://docs.stripe.com/payments/link/link-payment-integrations)
- [Address Element](https://docs.stripe.com/elements/address-element)
- [Dynamic payment methods](https://docs.stripe.com/payments/payment-methods/dynamic-payment-methods)
- [Payment method configurations](https://docs.stripe.com/payments/payment-method-configurations)

Payment Element dynamically presents methods allowed by the PaymentIntent/configuration, currency, country, account capability, browser, and customer context. Its wallet setting defaults to showing Apple Pay and Google Pay when possible. It also includes the Link prompt by default when Link is enabled for the applicable configuration.

Therefore:

- Link is not a missing React component in this repository. It is an existing Payment Element capability controlled by Stripe configuration and eligibility.
- Payment Element may already show wallet buttons. Adding Express Checkout changes prominence/layout and can add an express surface; it is not the prerequisite for basic wallet availability.
- Link's saved payment value applies immediately. Link does not automatically populate this store's standalone React contact/delivery fields. Stripe's supported shared autofill path is through Elements such as Address Element or explicitly passed customer data. Replacing the custom form with Address Element is out of scope and would need careful InPost/print validation analysis.
- The server-selected payment-method configuration must be valid in every account/mode. The current hard-coded ID was not present in the connected test account.

Connected configuration evidence is limited to the local **test-mode** credential: the default configuration had Apple Pay and Link active, Google Pay unavailable, and the repository's hard-coded configuration did not exist there. This is not evidence of the live account's method status.

## Express Checkout Element

Sources:

- [Express Checkout Element](https://docs.stripe.com/elements/express-checkout-element)
- [Accept a payment with Elements](https://docs.stripe.com/payments/accept-a-payment?payment-ui=elements)
- [Register payment method domains](https://docs.stripe.com/payments/payment-methods/pmd-registration)

Express Checkout Element can surface Link, Apple Pay, Google Pay, and other eligible one-click methods. Availability varies by browser/device, currency, country, account configuration, and registered domain. Stripe requires registration of every domain/subdomain where methods are rendered; domain registration is specifically required for Apple Pay. When Express Checkout and Payment Element are used together, wallet methods appear in Express Checkout rather than being duplicated in Payment Element.

Repository implications:

- The safe insertion point is **inside the existing `Elements` tree, above `PaymentElement`, after `/api/checkout` succeeds**. At that point required delivery/contact/locker data has already been validated and ceramics have been reserved. An Express control placed before those steps would be architecturally unsafe.
- Express Checkout shipping/contact collection must not replace the application's authoritative delivery data. InPost locker ID, pickup, print-country rules, custom consent, and shipping price are application requirements.
- The same post-validation placement works for ceramics and prints because the server has already selected the proper delivery contract. The wallet confirms only the PaymentIntent.
- The connected test account's payment-method domain list was empty, so a reliable wallet test is currently blocked there. Live/test domains must be verified separately.
- An express experiment needs a standard Payment Element fallback, because not every customer/device will be eligible.

There is no repository evidence that wallet discoverability is the current conversion bottleneck. The recommendation is therefore reduced and feature-flagged rather than a broad launch.

## Payment Links

Sources:

- [Create a Payment Link](https://docs.stripe.com/payment-links/create)
- [Customize Payment Links](https://docs.stripe.com/payment-links/customize?dashboard-or-api=api)
- [Payment Link URL parameters](https://docs.stripe.com/payment-links/url-parameters)
- [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment)

Payment Links create Stripe Checkout Sessions. `client_reference_id`, metadata, and custom fields can carry references, but they do not execute this repository's `reserve_pieces()` transaction, validate the current `piece_state`, create its internal order/items before payment, select InPost lockers, resolve signed print assets, or invoke its PaymentIntent webhook state machine. The “limit the number of completed purchases” feature counts completed Checkout Sessions; it is not a pre-payment lock shared with the storefront. It cannot prevent a Payment Link and storefront buyer racing for the same unique ceramic.

The current webhook does not subscribe to or handle `checkout.session.completed` or delayed Checkout Session events. A Payment Link sale would therefore not appear reliably in internal order history, inventory, email, conversions, InPost, or Prodigi without a second integration. Metadata can identify a proposed product but cannot make the inventory race atomic.

Consequences:

- unique ceramics and private-sale ceramics: skip;
- workshops/custom work/deposits/B2B: potentially useful only after the application defines a non-stock or separately reserved order type, payment schedule, refund/fiscal treatment, customer history, and webhook ingestion;
- prints: avoid unless the same print variant/asset/shipping/Prodigi contract is integrated; a generic link bypasses it;
- casual DM sales of ceramics: use the existing private-sale/internal checkout path, not a Dashboard-created link.

## Receipts, invoices, and customer communication

Sources:

- [Email receipts](https://docs.stripe.com/receipts)
- [Invoice lifecycle and sending](https://docs.stripe.com/invoicing/integration/workflow-transitions)

Stripe can send automatic successful-payment receipts based on Dashboard settings and payment data; charges also expose a hosted `receipt_url`. Dashboard branding/email settings are primarily configuration, though an integration can pass `receipt_email`.

The current checkout deliberately does not set `receipt_email`. After success it sends a localized custom order-confirmation email and creates/finalizes a Stripe Invoice, marks it paid out of band, and asks Stripe to send it. Enabling another generic payment receipt can produce a third customer message without adding shipping, locker, item, or fulfillment context.

These artifacts must not be conflated:

- **payment receipt:** evidence Stripe processed a payment;
- **order confirmation:** store-owned item, delivery, support, and fulfillment information;
- **commercial invoice:** accounting document describing a sale/payment;
- **fiscal/tax document:** jurisdiction-specific legal artifact, not made compliant merely by calling a Stripe email a receipt or invoice.

The audit does not determine Polish/Spanish/other fiscal compliance and intentionally excludes tax automation/Canary Islands handling. Live automatic-receipt settings could not be read with the available access. Keep the current communication ownership until accounting/legal requirements decide otherwise.

## Workbench, health, and recovery

Sources:

- [Workbench overview](https://docs.stripe.com/workbench/overview)
- [Event destinations in Workbench](https://docs.stripe.com/workbench/event-destinations)
- [Workbench health](https://docs.stripe.com/workbench/health)
- [Health alerts](https://docs.stripe.com/health-alerts)

Workbench provides API request/error inspection, event destinations, webhook delivery attempts, status, and resend tools. Stripe health alerts can notify operators about selected integration problems; exact availability can depend on account/tier and must be confirmed in the Dashboard.

This is primarily **Dashboard configuration plus an operational runbook**, not a reason to build a parallel monitoring UI. Repository changes are justified only for application-specific durable state, structured non-PII logs, correlation IDs, reconciliation commands, and failure states that Stripe cannot see (for example, a Stripe delivery returned 200 while invoice email failed).

Recommended ownership:

- Stripe: delivery failure, endpoint/API health, event resend, request inspection;
- Workers/Sentry: thrown handler, Queue/DLQ, application and external-service failures;
- Supabase: internal order/fulfillment reconciliation state;
- runbook/operator: replay decision, safe command, validation, and escalation.

## Webhook signatures, retries, ordering, and versioning

Sources:

- [Webhooks](https://docs.stripe.com/webhooks)
- [Resolve webhook signature errors](https://docs.stripe.com/webhooks/signature)
- [Process undelivered events](https://docs.stripe.com/webhooks/process-undelivered-events)
- [Webhook endpoint versioning](https://docs.stripe.com/webhooks/versioning)
- [Event destinations](https://docs.stripe.com/event-destinations)

Stripe requires the exact raw request body for signature verification. The repository correctly uses `req.text()` and `constructEventAsync()`.

Stripe retries live webhook deliveries for up to three days with exponential backoff; sandbox retries are shorter. Events can be duplicated and are not guaranteed to arrive in creation order. Operators can manually resend from Dashboard for a limited period or with the CLI for a longer documented period. Returning 2xx to a manually processed event does not stop an already scheduled automatic retry, so handlers must remain idempotent.

The repository's local guards handle many duplicates, but unordered refund/success events and the split refund/inventory transition do not converge safely. The proper fix is not merely a “processed IDs” table that is marked complete before work. A record must distinguish received, processing/lease, completed, retryable failure, and terminally ignored state, and domain transitions must be independently resumable/transactional.

Endpoint version is fixed when configured and affects generated event data. Keep it aligned with the SDK's expected payload version through an explicit package-bump ritual and contract tests.

## SDK and Cloudflare runtime compatibility

Sources:

- [API versioning with stripe-node](https://docs.stripe.com/api/versioning?lang=node)
- [Stripe SDK versioning](https://docs.stripe.com/sdks/versioning?lang=node)
- [stripe-node runtime configuration](https://github.com/stripe/stripe-node#configuration)

The installed stripe-node `22.2.1` bundles API version `2026-05-27.dahlia`. Modern stripe-node sends the API version current when that SDK was released unless an override is provided. The repository comment claiming that omission means “account-default” is incorrect.

`src/lib/stripe.ts` explicitly uses Stripe's fetch HTTP client and async crypto path; the webhook uses `constructEventAsync`. These are the appropriate web-platform/Workers-compatible patterns. No Node-only raw-body middleware is inserted before verification. The connected test webhook version matches the installed SDK. Live parity remains to be verified.

No current Stripe documentation found a Cloudflare Workers incompatibility that requires moving this integration to a Node server. Runtime changes are not recommended.

## Dashboard/configuration versus code

| Item | Dashboard / external configuration | Repository work |
| --- | --- | --- |
| Enable/disable Link and payment methods | Yes, payment-method configuration | Validate environment variable; render/fallback tests |
| Register wallet domains | Yes, each mode/domain/subdomain | Documentation and smoke-test support only |
| Automatic payment receipts | Yes | Keep `receipt_email` policy explicit; no new code by default |
| Workbench/health alerts | Yes | Runbook, owner, correlations, reconciliation commands |
| Webhook subscribed events/version | Yes | Handler contract and contract tests |
| Express Checkout layout | No | React Element integration behind a flag, if approved |
| One-of-one reservation | No | Supabase/app domain logic; never delegated to Payment Links |
| Event convergence/idempotency | No | Database and webhook state-machine work |
| Checkout Sessions migration | New Stripe integration | Not recommended in Stage 1 |
