# 07 — Regression & E2E coverage for the print path (Finding 11)

> **Severity: High (as regression risk).** The print rules are **correct today but almost entirely untested** at the route/server level. This plan locks the *existing correct behaviour* down. Tests for *new* behaviour live in that behaviour's own domain plan (`01`–`06`).
> **Effort: `high`.** Ship last, after `01`–`06`, so the new behaviour is included in the safety net.

## Goal

Add the missing tests so a future change can't silently regress the ceramics ⇄ prints separation:

- checkout print-branch validation (delivery/country/shipping) — currently every checkout test uses ceramic `odbior`;
- webhook fulfilment routing (Prodigi vs InPost);
- `enqueue.ts` and `callbacks.ts` (**zero tests today**) + `process-job` happy path;
- the InPost webhook route (only the parser is tested today);
- E2E: a print purchase and a mixed-cart rejection.

## Current test coverage (verified)

Exists: `checkout/route.test.ts` (22, all ceramic `odbior`), `stripe/webhook/route.test.ts` (16), `admin/create-shipment/route.test.ts` (5), `return.test.ts` (7), `admin/fulfillment.test.ts` (9), `shipment.test.ts` (21), `server/fulfilment/process-job.test.ts` (9), `server/prodigi/mapper.test.ts` (8), `server/prodigi/client.test.ts` (4).
**Missing:** `server/fulfilment/enqueue.test.ts`, `server/prodigi/callbacks.test.ts`, any InPost-webhook-route test. E2E: only `e2e/print-configurator.spec.ts` (stops at add-to-cart) — no print purchase, no mixed-cart.

## Unit / integration tests to add

### Checkout print branch — `src/app/api/checkout/route.test.ts`
Cover the `hasPrints` branch (`route.ts` ~L79-106) and country gate:
- print + `paczkomat` → `400 invalid_delivery`
- print + `odbior` → `400`
- print + kurier, no address → `400`
- print + kurier `US` / `CH` (outside EU+UK) → `400`
- print + kurier `DE` → `200`, `shipping === printShippingOf('DE', framed?, currency)`
- ceramic + kurier `DE` → `400` (ceramics are PL-only)
- print PL → `200`
- mixed cart → `400 mixed_cart`
- framed vs loose → correct differing shipping amount

### Webhook routing — `src/app/api/stripe/webhook/route.test.ts`
Assert `createShipment`'s DB-driven routing (`route.ts` ~L385-402):
- print `variant` rows → `enqueueProdigi` called, `createOrderShipment` **not**
- ceramic rows → `createOrderShipment` called, `enqueueProdigi` **not**
- defensive mixed order → **both** fire (`processJob` still only pulls print items via `.not('variant','is',null)`)

### New: `src/server/fulfilment/enqueue.test.ts`
- upsert idempotency (same order enqueued twice → one job / stable idempotency key)
- conflict → re-select existing job
- queue `send` failure → throws (so the webhook can let Stripe retry)

### New: `src/server/prodigi/callbacks.test.ts`
- invalid token → `401`
- dedup / lease on replay (no double-processing)
- stage → status mapping via `mapProdigiStage`
- callback for an unknown local order → error path (no crash)
- **tracking email sent once** on `Complete` (the Finding 6 behaviour from `04`) — replay sends none

### `src/server/fulfilment/process-job.test.ts` (extend the 9)
- happy path: claim → `postOrder` → persist `prodigi_orders` → `fulfilment_submitted`
- `409` (order already exists at Prodigi) recovery
- (from `01`) non-`paid` order → no `postOrder`

### New: InPost webhook route test
- parse + status update + shipping email fires **only** for ceramic orders (never for prints)

## E2E (Playwright)

### New: `e2e/print-purchase.spec.ts`
Configurator → cart shows **only** "Dostawa kurierem" (assert **no** paczkomat, **no** odbiór, **no** Geowidget) → pick a country ≠ PL → test payment → return page success.

### New: `e2e/mixed-cart.spec.ts`
Add a print, then add a ceramic from its PDP → assert the mixed-cart notice + disabled checkout → remove the print → ceramic checkout works. (Also exercises the Finding 10 guard from `06`.)

### Extend an existing ceramic spec
Add an assertion that the **country selector is absent** on the ceramic checkout path.

## Acceptance criteria

- [ ] All new unit tests fail against the pre-change code where applicable and pass now; `npm run test` green.
- [ ] `enqueue.ts` and `callbacks.ts` go from 0 tests to covered (happy path + key error paths).
- [ ] Checkout print-branch matrix (above) all present and passing.
- [ ] Webhook routing asserts Prodigi-vs-InPost dispatch from the DB discriminator.
- [ ] E2E `print-purchase` and `mixed-cart` specs pass against a preview/deploy (`npm run test:e2e` / the appropriate tagged run).

Run: `npm run test` (full suite), `npm run lint`, `npm run build`, then the E2E specs against a preview.

## Boundaries

- These are **regression** tests for behaviour that is already correct — do not change production behaviour here. If a test reveals a real bug, note it in `PROGRESS.md` and fix it in the owning domain plan, not here.
- Mock the Prodigi client, the queue, Stripe, and Supabase at the boundaries used by the existing tests — match the established test patterns in the neighbouring files; don't introduce a new mocking framework.
