# Executive Summary — Event System Audit Fix Plans (2026-07-26)

> Plain-language summary for non-technical stakeholders. No code was shipped in this PR — it's a set of six detailed, ready-to-execute repair plans written by our engineering audit of how the store tracks orders, payments, and marketing data.

## What this PR is

Following a full audit of the store's checkout, payment, and analytics "plumbing," we wrote six independent, step-by-step fix plans covering the most important problems found. Each plan is scoped so it can be built and shipped on its own, without waiting for the others.

## Why it matters

- **Protects revenue.** The single most important finding: in a rare but real scenario, a customer's card gets declined, they retry with a different card, and the retry *succeeds* — but our system was treating the first decline as final. That means we could take a customer's money and never send them a confirmation, never ship the order, and never count the sale. One of the six plans (`payment-failed-state-machine`) fixes exactly this and adds an automatic alert if it ever happens again.
- **Protects customer trust and privacy.** Two plans (`consent-pii-hygiene`, `resend-email-tracking`) close gaps where private tokens or ad-tracking identifiers could leak into analytics against a customer's wishes, and make sure we actually find out when an order-confirmation email bounces instead of the customer being left in the dark.
- **Improves the reliability of sales/marketing numbers.** One plan (`server-conversions-reliability`) hardens the reporting we send to Google and Meta about purchases and refunds, so ad spend decisions are based on accurate, non-duplicated, non-lost data.
- **Closes blind spots in reporting for the prints product line.** Another plan (`client-funnel-analytics-gaps`) fixes missing tracking on the fine-art prints pages, so we can see the full customer journey for that product line the way we already can for ceramics.
- **Reduces future risk.** The last plan (`analytics-test-coverage-gaps`) adds automated tests around the tracking code, so future changes are far less likely to silently break something we depend on for decision-making.

## What happens next

No live systems were touched yet — this PR is the plan, not the fix. Each plan is designed to be picked up and implemented as its own small, reviewable change, starting with the payment retry fix as the highest-priority item.