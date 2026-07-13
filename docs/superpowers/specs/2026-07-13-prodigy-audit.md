---

Prodigi Integration E2E + Test Suite — Audit Report

▎ Note on naming: the brief says "Prodigy"; in this repo it is Prodigi (src/server/prodigi/), a print-on-demand fulfilment partner. This audit covers the Prodigi integration and its full test surface (unit, route, pgTAP, E2E, CI). Read-only audit — no code changed.

1. Executive summary

The Prodigi integration has an unusually strong unit/route test layer and a weak integration-fidelity and end-to-end layer. Confidence is high that the code's internal logic is correct and low that it will keep working against the real Prodigi API or the real Cloudflare Queue.

What's genuinely good:

- The fulfilment state machine — enqueue → process → callback → cancel — is covered by ~120 targeted tests that exercise the important branches: idempotency-key conflicts, 409 duplicate recovery, lease/CAS dedup, fail-closed asset resolution, retryable-vs-terminal failure routing, mid-submission refund, claim-once alerts, casing variants. (process-job.test.ts, callbacks.test.ts, cancel-print.test.ts, enqueue.test.ts, client.test.ts, mapper.test.ts, print-assets/[id]/route.test.ts, stripe/webhook/route.test.ts).
- The DB constraints that back the idempotency claims exist in the migrations (fulfilment_jobs.idempotency_key unique, webhook_events_dedup, prodigi_order_id unique, partial fulfilment_jobs_order_unique).
- Webhook routing (print→Prodigi, ceramic→InPost, mixed→both) and refund→cancel are asserted at the route level.
- Security hygiene in the smoke harness is careful (HMAC sig redaction, URL scrubbing from error strings).
- I ran the Prodigi cluster: 21 files / 277 tests pass; central route+fulfilment tests: 6 files / 120 tests pass.

What's not good enough for "production-relevant coverage":

- No test ever touches the real Prodigi v4 API. Every interaction is hand-mocked; the payload mapper asserts shapes against our own expectations, not Prodigi's schema. No msw/nock/fixtures. (Finding H-1)
- The one E2E that could exercise enqueue→queue→processJob→Prodigi asserts only that the success page renders, and it is excluded from every run by default. No E2E references fulfilment internals at all. (Finding H-2)
- The Cloudflare Queue consumer's ack/retry/DLQ branching is untested, and the DLQ has no consumer or alert — a paid print order that exhausts 10 retries vanishes silently. (M-3, M-5)
- The idempotency DB constraints have no pgTAP test; the unit tests mock the upsert, so a migration that drops a unique index stays green. (M-4)
- The Prodigi callback token is compared with plain !== even though the repo already has a timingSafeEqual used for the Resend webhook. (L-6)

Net: the suite proves the integration is internally correct and well-factored, but does not prove it is correct against Prodigi or resilient at the queue/DLQ boundary. Treat the unit layer as production-trusted; treat anything involving the real Prodigi API or the queue runtime as unverified by automation.

1. Current coverage map

Scenario: Print cart UI (courier-only, no locker, EU country)
Files: e2e/print-purchase.spec.ts (@ci)
Systems exercised: Storefront UI
Real vs mocked: Real app, hermetic build; no backend
Key assertions: Shipping options, country select, cart badge
Status: ✅ Covered
────────────────────────────────────────
Scenario: Print configurator (variants, price, visibility)
Files: e2e/print-configurator.spec.ts (@ci)
Systems exercised: Storefront UI
Real vs mocked: Real app
Key assertions: Radiogroup state, pinned price 720 zł, selector visibility
Status: ✅ Covered
────────────────────────────────────────
Scenario: Mixed-cart rejection (3 layers)
Files: e2e/mixed-cart.spec.ts (@ci)
Systems exercised: Storefront UI + localStorage
Real vs mocked: Real app
Key assertions: PDP guard, notice, checkout disable/restore
Status: ✅ Covered
────────────────────────────────────────
Scenario: Paid print → real Stripe → success page
Files: e2e/print-purchase.spec.ts (@destructive)
Systems exercised: Stripe (real), Prodigi (real, sandbox)
Real vs mocked: Real Stripe + real Prodigi sandbox
Key assertions: Only checkoutSuccess visible
Status: ⚠️ Asserts page, not fulfilment; opt-in only
────────────────────────────────────────
Scenario: Enqueue job + queue send + idempotency
Files: src/server/fulfilment/enqueue.test.ts
Systems exercised: Supabase, CF Queue
Real vs mocked: Both mocked
Key assertions: Upsert idempotency key, conflict recovery, send throw, local-dev waitUntil
Status: ✅ Covered (mocked)
────────────────────────────────────────
Scenario: processJob (claim, POST, persist, fail-closed asset)
Files: src/server/fulfilment/process-job.test.ts
Systems exercised: Supabase, Prodigi, R2, asset repo
Real vs mocked: All mocked
Key assertions: 12 paths incl. 409 recovery, R2/secret/asset missing, transient re-throw, r2_key mismatch
Status: ✅ Covered (mocked)
────────────────────────────────────────
Scenario: Prodigi HTTP client
Files: src/server/prodigi/client.test.ts
Systems exercised: Prodigi API
Real vs mocked: fetch stubbed
Key assertions: URL/key per env, path encoding, retryable mapping (5xx/429), 409 body, network err
Status: ✅ Covered (mocked)
────────────────────────────────────────
Scenario: Payload mapper
Files: src/server/prodigi/mapper.test.ts
Systems exercised: (pure)
Real vs mocked: n/a
Key assertions: idempotency key, recipientCost, attributes, address, throw paths
Status: ✅ Covered (vs own schema, not Prodigi's)
────────────────────────────────────────
Scenario: Prodigi callback (dedup, lease, ship email, mapping)
Files: src/server/prodigi/callbacks.test.ts
Systems exercised: Supabase, Prodigi, email, Sentry
Real vs mocked: All mocked
Key assertions: CloudEvents 400, lease in-flight/done, ship-once claim+release, never-downgrade, 500 paths
Status: ✅ Covered (mocked); stale-lease takeover not directly tested
────────────────────────────────────────
Scenario: Callback route (auth, JSON, shape)
Files: src/app/api/webhooks/prodigi/[token]/route.test.ts
Systems exercised: Route
Real vs mocked: handleProdigiCallback mocked
Key assertions: 401 bad token, 400 bad JSON, delegate, error mapping
Status: ✅ Covered (mocked)
────────────────────────────────────────
Scenario: Refund → cancel/alert Prodigi
Files: src/server/fulfilment/cancel-print.test.ts, stripe/webhook/route.test.ts (Finding 1)
Systems exercised: Supabase, Prodigi, email, Sentry
Real vs mocked: All mocked
Key assertions: 18 paths: pre/mid/retryable submission, shipped, FailedToCancel, CAS-lost, casing
Status: ✅ Covered (mocked)
────────────────────────────────────────
Scenario: Signed print-asset route (GET/HEAD)
Files: src/app/api/print-assets/[id]/route.test.ts
Systems exercised: Route, R2, asset repo
Real vs mocked: R2 + DB mocked
Key assertions: 503/403/404/410/200 matrix, expiry, headers, content-type
Status: ✅ Covered (mocked)
────────────────────────────────────────
Scenario: Webhook fulfilment routing
Files: src/app/api/stripe/webhook/route.test.ts (Finding 11)
Systems exercised: Supabase, enqueue, InPost
Real vs mocked: enqueue + shipment mocked
Key assertions: print→enqueue only, ceramic→shipment only, mixed→both
Status: ✅ Covered (mocked)
────────────────────────────────────────
Scenario: Asset publish RPC + immutability trigger
Files: supabase/tests/print_fulfilment_assets.sql (pgTAP)
Systems exercised: Real local Postgres
Real vs mocked: Real DB (BEGIN/ROLLBACK)
Key assertions: 35 assertions: coverage, dimension/revision mismatch, atomic rollback, immutability
Status: ✅ Covered (real DB)
────────────────────────────────────────
Scenario: Signed-route liveness
Files: .github/workflows/post-deploy-smoke.yml, src/lib/print-asset-smoke.ts
Systems exercised: Live origin, R2, Supabase
Real vs mocked: Real (HEAD against prod)
Key assertions: 200 + headers for one asset
Status: ⚠️ --allow-missing green-skip pre-launch; narrow
────────────────────────────────────────
Scenario: Queue consumer ack/retry/DLQ
Files: worker.ts
Systems exercised: CF Queue runtime
Real vs mocked: —
Key assertions: none
Status: ❌ Not covered
────────────────────────────────────────
Scenario: Fulfilment idempotency constraints
Files: (migrations only)
Systems exercised: DB
Real vs mocked: —
Key assertions: no pgTAP
Status: ❌ Not covered
────────────────────────────────────────
Scenario: Real Prodigi v4 order create
Files: —
Systems exercised: Prodigi sandbox
Real vs mocked: —
Key assertions: none
Status: ❌ Not covered

1. Findings



H-1 — No real Prodigi API contract is validated anywhere

- Category: Integration fidelity / coverage
- Evidence: package.json has no msw/nock/pollyjs (verified — "none installed"); no **fixtures**/*.har. mapper.test.ts:56-65 asserts attributes: { color: 'natural', mount: '2.4mm', mountColor: 'Snow white' }, sizing: 'fillPrintArea', printArea: 'default' — all against the repo's own expectations, not Prodigi's v4 schema. client.test.ts:44 stubs fetch. The only real-API touchpoints are manual operator scripts outside the test suite: npm run prodigi, npm run sync-prodigi-skus, npm run print-assets:sandbox-matrix.
- Why it matters: Prodigi schema drift (a renamed sizing value, a changed attribute key, altered cancel-outcome casing, a new required field) silently breaks fulfilment while npm test and CI stay green. This is the integration's highest-risk unknown.
- Likely failure mode: Paid print order submitted to Prodigi with a shape Prodidi now rejects → failed_action_required → silent backlog, no signal until a customer complains their print never arrived.
- Recommended fix: Add a recorded-fixture contract test (capture one sandbox POST /orders, GET /orders/{id}/actions, cancel, and a callback) and assert the mapper's output round-trips through the real client parser. Run it against sandbox in CI behind a secret, or as a manually-triggered workflow. Cheapest first step: a sandbox order create → cancel smoke in a workflow_dispatch job mirroring post-deploy-smoke.yml.

H-2 — The destructive print-purchase E2E asserts the page, not fulfilment; and it's off by default

- Category: Coverage / E2E
- Evidence: e2e/print-purchase.spec.ts:84 — the only assertion after payment is await expect(page.locator(sel.checkoutSuccess)).toBeVisible(...). No assertion on fulfilment_jobs, prodigi_orders, queue send, or the sandbox order. playwright.config.ts:28 — grepInvert: /@destructive/ excludes it from every run unless E2E_DESTRUCTIVE=1. Repo-wide grep: no e2e file references enqueueProdigi/processJob/prodigi_orders/fulfilment_jobs.
- Why it matters: This is the single test that could prove the wiring from a real Stripe payment_intent.succeeded through to a real Prodigi sandbox order. As written it proves only "the browser reached the success page" — which the ceramic purchase E2E already proves for the shared parts.
- Likely failure mode: A regression in the enqueue call site, the queue binding, or processJob ships undetected because nothing end-to-end exercises it.
- Recommended fix: After the destructive payment settles, poll the storefront/admin (or a read-only checkout-status endpoint) for the order's fulfilment state and assert a Prodigi sandbox order id appears in prodigi_orders within a timeout. At minimum, assert the fulfilment_jobs row reached fulfilment_submitted/in_production. Gate it behind the existing E2E_PRODIGI_SANDBOX=1 blocker so it stays sandbox-only.

M-3 — The Cloudflare Queue consumer's ack/retry/DLQ branching is untested

- Category: Coverage / reliability
- Evidence: worker.ts:43-56 — the handler that decides msg.ack() vs msg.retry() for every print order:
await processJob(msg.body, env, ctx)
.then(() => msg.ack())
.catch((err) => {
  if ((err as { retryable?: boolean })?.retryable === false) msg.ack();
  else msg.retry();
});
- No test file imports or exercises this. processJob throws plain Errors (no .retryable) for transient failures (process-job.ts:167, :127), and ProdigiError carries .retryable only for HTTP errors.
- Why it matters: Four lines of code decide whether a retryable failure is retried or silently acked. A refactor (e.g. reading the wrong property, or processJob starting to throw a typed error without retryable) could route every transient failure to ack() → silent loss of paid print orders. Blast radius = all fulfilment.
- Likely failure mode: Retryable DB/Prodigi hiccup → msg.ack() → job gone, no Prodigi order, no retry, no DLQ entry.
- Recommended fix: Extract the catch into a pure decideMessageDisposition(err): 'ack' | 'retry' and unit-test it against: success, plain Error, ProdigiError{retryable:true}, ProdigiError{retryable:false}, and the processJob-thrown transient cases. Cloudflare docs confirm per-message ack/retry is the contract (Batching, Retries and Delays).

M-4 — No pgTAP test for the Prodigi idempotency constraints

- Category: Coverage / data integrity
- Evidence: supabase/tests/ contains only print_fulfilment_assets.sql (35 assertions) and private-sale.sql — neither touches fulfilment_jobs, prodigi_orders, or webhook_events. The constraints exist in migrations (20260626120002_fulfilment_jobs.sql:7 idempotency_key text not null unique; :13-15 partial unique fulfilment_jobs_order_unique; 20260626120003_webhook_events.sql:13-15 webhook_events_dedup; prodigi_orders.prodigi_order_id text unique). But the unit tests mock the upsert/conflict path (enqueue.test.ts:28-31, callbacks.ts:9 PG_UNIQUE_VIOLATION = '23505').
- Why it matters: The idempotency guarantees the code relies on (enqueue conflict recovery, callback dedup, the "one active job per order" assumption in cancelPrintFulfilment) live entirely in DB constraints the test suite never asserts. A migration that drops/weakens them passes CI.
- Likely failure mode: A future migration relaxes fulfilment_jobs_order_unique or drops webhook_events_dedup → duplicate jobs/orders, duplicate shipping emails — with green tests.
- Recommended fix: Add supabase/tests/fulfilment_idempotency.sql asserting: duplicate idempotency_key insert raises 23505; duplicate (provider, provider_event_id) raises 23505; a second active job for the same order_id is rejected while a cancelled one coexists.

M-5 — DLQ is configured but has no consumer, test, or alert

- Category: Operational readiness / coverage
- Evidence: wrangler.jsonc:39-44 — max_retries: 10, dead_letter_queue: "prodigi-fulfilment-dlq". No consumer is defined for the DLQ; no test; no alarm.
- Why it matters: Cloudflare Queues delete a message after max_retries unless a DLQ is set (Dead Letter Queues) — the DLQ is correctly set (good). But an unmonitored DLQ is a silent backlog: a paid print order that fails fulfilment 10× lands there with nobody looking.
- Likely failure mode: Transient-but-persistent failure (e.g. a bad asset row) → 10 retries → DLQ → customer never receives print, no pager.
- Recommended fix: Add a DLQ consumer that alerts (Sentry message + studio email, reusing the cancelPrintFulfilment alert path) for any message that reaches it. Optionally a scheduled check that fails loudly if the DLQ is non-empty.

L-6 — Prodigi callback token compared with plain !== (inconsistent with Resend)

- Category: Security
- Evidence: src/app/api/webhooks/prodigi/[token]/route.ts:14 — if (token !== env.PRODIGI_CALLBACK_TOKEN). The repo already implements and uses a constant-time compare at src/lib/resend-webhook.ts:32 (timingSafeEqual, used at :102).
- Why it matters: Timing side-channel on the auth token. Realistic severity is low on Workers (network jitter dominates), but the inconsistency means the codebase considered this worth doing for Resend and not for Prodigi.
- Likely failure mode: Theoretical timing leak of the callback token; more concretely, a future reviewer copies the Prodigi pattern for a more sensitive secret.
- Recommended fix: Reuse timingSafeEqual from resend-webhook.ts (extract to a shared util) for the Prodigi token check.

L-7 — Callback stale-lease CAS takeover not directly tested

- Category: Coverage / concurrency correctness
- Evidence: callbacks.ts:60-77 implements compare-and-swap takeover of an expired processing lease (the concurrency-correctness guarantee). callbacks.test.ts tests the fresh in-flight lease ("In flight", :226) and the done replay, but no test delivers a callback whose processing_started_at is older than LEASE_MINUTES and asserts the CAS wins and processing runs.
- Why it matters: The takeover branch is exactly the path that runs under concurrent redelivery; it's the least-exercised and highest-concurrency-risk code in the handler.
- Recommended fix: Add a test with existingEvent: { status: 'processing', processing_started_at: <now - 10min> } asserting mockGetOrder is called and the event ends done.



L-8 — Default Playwright target is production; local runs hit prod in parallel

- Category: Reliability / safety
- Evidence: playwright.config.ts:13 — BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? '[https://anna-ciok.studio](https://anna-ciok.studio)'. :33 — workers: ... ? 1 : undefined → parallel against prod when run locally without env. CI overrides to localhost (e2e.yml:57). grepInvert @destructive (:28) protects against the worst mutation, and print-purchase.spec.ts:52-61 has env blockers for its destructive block.
- Why it matters: A bare npx playwright test locally hammers the live storefront in parallel. A careless E2E_DESTRUCTIVE=1 locally (without PLAYWRIGHT_BASE_URL) would charge real cards and create real Prodigi orders against production.
- Likely failure mode: Accidental prod load/mutation from a developer machine.
- Recommended fix: Default BASE_URL to [http://localhost:3000](http://localhost:3000) (hermetic), and require an explicit opt-in (e.g. E2E_TARGET_PROD=1) to hit anna-ciok.studio. Playwright's documented pattern is workers: process.env.CI ? 1 : undefined and hermetic webServer (test-parallel, test-webserver); the repo already uses the hermetic webServer for localhost, so flipping the default is low-risk.

I-9 — Pinned price literal in the configurator E2E

- Category: Maintainability
- Evidence: e2e/print-configurator.spec.ts:39 asserts '720 zł' with an inline note "Pinned literal: update here when SIZE_BASE / *_DELTA tables change."
- Why it matters: Brittle, but explicitly acknowledged. Informational only.
- Recommended fix: Optional — derive the expected value from print-pricing.ts in the test instead of hard-coding.

I-10 — Hoisted ProdigiError mock constructor diverges from the real signature

- Category: Mock fidelity
- Evidence: process-job.test.ts:31 mock ProdigiError(m, s, b, r) (message, status, body, retryable) vs real client.ts:21 (message, status, retryable, body=null). processJob reads .status/.body (both present), so the one 409 test is functionally correct.
- Why it matters: The mock doesn't enforce the real constructor signature, so a signature change to ProdigiError wouldn't be caught by this test. Low impact today.
- Recommended fix: Import the real ProdigiError class instead of redeclaring it in the hoisted mock.

1. Missing test scenarios (by business risk)

High risk

1. Real Prodigi v4 order lifecycle against sandbox — create → actions → cancel → callback replay. The #1 gap (H-1).
2. End-to-end paid print order → fulfilment state — assert fulfilment_jobs → prodigi_orders progression after a real (sandbox) payment (H-2).
3. Queue consumer disposition — ack on success, retry on transient, ack on retryable===false, DLQ after max_retries (M-3, M-5).

Medium risk
4. DB-level idempotency constraints (pgTAP) — duplicate idempotency_key, duplicate callback event id, duplicate active job per order (M-4).
5. Callback stale-lease CAS takeover under concurrent duplicate delivery (L-7).
6. DLQ non-empty alerting — a message landing in prodigi-fulfilment-dlq raises a signal (M-5).
7. Prodigi callback for an order whose prodigi_orders row doesn't exist yet (callback raced processJob's persist) — the merchantReference fallback path is unit-tested in isolation but not as a route→handler integration with realistic timing.

Lower risk
8. Print-asset URL at exact expiry boundary (exp == now).
9. Callback with shipments but no tracking number — sendPrintShippingEmailOnce picks shipments[0]; the no-tracking branch is implicit.
10. PRODIGI_ENV=live end-to-end — the mapper/client switch on env is unit-tested, but nothing asserts a live-configured worker would never hit sandbox URLs.

1. Flakiness and reliability assessment

Concrete sources of nondeterminism:

- Default prod target + parallel workers (L-8). Local npx playwright test → parallel reads against anna-ciok.studio. Reproduce: run locally with no env. Eliminate by flipping the default to localhost.
- Inventory-dependent selectors against prod. mixed-cart.spec.ts:25 picks the first :not([data-sold="true"]) /kubki tile; against prod this depends on live stock. Hermetic CI is fine (backendless → all available). Reproduce: run mixed-cart against a prod category that is fully sold.
- retries: 0 everywhere (playwright.config.ts:25). Good for signal (no flaky masking), recommended by Playwright for CI (test-retries), but means any transient prod hiccup fails the build when run against prod. Eliminate by not running against prod by default.
- Hermetic mode degrades to "all available." getSoldIds catches and returns [] (per e2e.yml:40-41 comment), so @ci never exercises real sold/reserved state. Not flakiness per se, but a fidelity ceiling.

Things that are deliberately non-flaky (good):

- resetCart uses a sessionStorage guard so re-init on each navigation doesn't wipe items (helpers/checkout.ts:25-34).
- App-owned data-testid selectors throughout, not brittle CSS/text.
- Email-backoff tests use vi.useFakeTimers() to avoid ~1.2s wall-clock (route.test.ts:715).
- workers: 1 in CI and destructive runs prevents shared-inventory races (playwright.config.ts:33).
- pgTAP wraps each file in BEGIN/ROLLBACK (print_fulfilment_assets.sql:10,380) — no fixture leakage.

1. Recommended remediation plan

Immediate (high impact, low effort)

1. Extract + test the queue disposition (worker.ts:51-54 → pure decideMessageDisposition). Impact: closes the silent-loss blast radius (M-3). Effort: ~1h. Deps: none.
2. Reuse timingSafeEqual for the Prodigi callback token (L-6). Impact: security consistency. Effort: ~15 min.
3. Flip Playwright default BASE_URL to localhost, require opt-in for prod (L-8). Impact: removes the prod-by-default footgun. Effort: ~30 min + verifying hermetic webServer still covers the @ci specs.

Near-term (high impact, medium effort)
4. pgTAP fulfilment_idempotency.sql asserting the three unique constraints (M-4). Impact: makes the idempotency guarantees testable at the DB. Effort: ~2h. Deps: local Supabase.
5. Destructive E2E fulfilment assertions — poll for prodigi_orders/fulfilment_jobs state after the sandbox payment (H-2). Impact: the only path that exercises real wiring. Effort: ~0.5 day. Deps: a read endpoint or admin access in the sandbox preview.
6. DLQ consumer + alert (M-5). Impact: no silent loss of unfulfillable orders. Effort: ~0.5 day. Deps: Sentry/email already wired.
7. Callback stale-lease takeover test (L-7). Effort: ~30 min.

Longer-term (highest impact, highest effort)
8. Prodigi v4 contract test — recorded fixtures or a sandbox smoke workflow (H-1). Impact: catches schema drift, the integration's biggest unknown. Effort: ~1-2 days. Deps: sandbox key as a CI secret; decision on fixture-replay vs live-sandbox.

Suggested order: 1 → 2 → 3 → 4 → 7 → 6 → 5 → 8.

1. Verification status

Executed (green):

- npx vitest run on the Prodigi cluster (src/server/prodigi, src/server/fulfilment, src/server/print-assets, src/app/api/webhooks/prodigi, src/app/api/print-assets, src/app/api/admin/revoke-print-asset, src/lib/print-*.test.ts) → 21 files, 277 tests passed, 901ms.
- npx vitest run on central route + fulfilment tests (stripe/webhook/route.test.ts, checkout/route.test.ts, cancel-print.test.ts, enqueue.test.ts, process-job.test.ts, callbacks.test.ts) → 6 files, 120 tests passed, 888ms.

Not executed (environment limits):

- E2E (npm run test:e2e) — needs the deployed site or a local build+serve; the @destructive print-purchase spec additionally needs real Stripe + a PRODIGI_ENV=sandbox preview + E2E_DESTRUCTIVE=1/E2E_PRODIGI_SANDBOX=1. Not run.
- pgTAP (supabase db start && supabase test db) — needs Docker/local Supabase. Not run; read print_fulfilment_assets.sql statically.
- Full npm test / npm run typecheck / npm run build — not run; only the Prodigi subset was executed.
- .env.example — in a permission-denied directory; relied on AGENTS.md's env-var documentation instead.

Areas not verified / assumptions:

- I did not confirm the Prodigi v4 schema externally (Finding H-1 is precisely that nobody has). Recommendations H-1/H-2 assume a sandbox order id is observable post-payment; confirm the sandbox preview exposes it.
- Cloudflare Queue ack/retry/DLQ behavior is cited from official docs, not reproduced against this Worker.
- The prior internal audit docs/audit-ceramics-prints-separation.md (Findings 1–11) appears to have driven most of the current tests (test files cite "Finding 6/10/11"); I treated those as already-resolved and focused on residual gaps.

---

## Supplementary review (independent validation, 2026-07-13)

Second pass: re-read source, re-ran the Prodigi vitest cluster (22 files / **287** tests — up from 277 at audit time), confirmed migrations and worker/queue config. **All original findings (H-1 through I-10) are valid** with the nuance notes below.

### Validation notes on original findings

| Finding | Verdict | Nuance |
|---------|---------|--------|
| H-1 | ✅ Confirmed | No msw/nock in `package.json`; `mapper.test.ts:56-58` asserts self-referential attribute shapes |
| H-2 | ✅ Confirmed | `e2e/print-purchase.spec.ts:84` — success page only; zero e2e references to `fulfilment_jobs` / `prodigi_orders` |
| M-3 | ✅ Confirmed | `worker.ts:48-54` untested; **today** terminal failures in `processJob` **return** (acked via `.then()`), so the `retryable === false` catch branch is mostly dead — the blast radius is a **refactor** that starts throwing without `.retryable` |
| M-4 | ✅ Confirmed | `supabase/tests/` has only `print_fulfilment_assets.sql` + `private-sale.sql`; constraints in `20260626120002` / `20260626120003` |
| M-5 | ✅ Confirmed | `wrangler.jsonc:39-44` — DLQ set, no consumer; runbook (`docs/print-asset-runbook.md:81-86`) documents manual recovery only |
| L-6 | ✅ Confirmed | `route.ts:14` plain `!==`; `resend-webhook.ts:32` has `timingSafeEqual` (not exported — would need extraction) |
| L-7 | ✅ Confirmed | `callbacks.test.ts:226-234` tests fresh in-flight lease only; no stale `processing_started_at` takeover case |
| L-8 | ✅ Valid, intentional trade-off | `playwright.config.ts:6-8` documents prod default for real Stripe webhook wiring; **CI** (`e2e.yml:57`) overrides to `localhost:3000`. Risk is local `npx playwright test` without env — mitigated by `@destructive` grepInvert and `E2E_PRODIGI_SANDBOX` blocker |
| I-9 | ✅ Confirmed | Informational |
| I-10 | ✅ Confirmed | `process-job.test.ts:31-32` mock ctor `(m,s,b,r)` vs real `client.ts:21-26` `(m,s,r,b)` |

### Additional findings (not in original audit)

**M-6 — Admin fulfilment UI is blind to Prodigi state**

- Category: Operational readiness
- Evidence: `fulfillment.ts:56-61` excludes `stage === 'prodigi'` from the packing queue; `FulfillmentActions.tsx:56-58` renders static "Wysyłka: Prodigi" with no actions. No `prodigi_order_id`, Prodigi stage, tracking, `fulfilment_jobs.status`, or `last_error` on `/admin/fulfillment/[id]`. Operators must use `npm run orders -- order get <uuid>`.
- Why it matters: Paid print orders are invisible in queue metrics and lack in-dashboard triage — exactly when DLQ/manual recovery matters most.
- Recommended fix: Surface `prodigi_orders` + latest `fulfilment_jobs` row on the order detail page (read-only first).

**M-7 — Planned admin retry-fulfilment never built**

- Category: Operational readiness
- Evidence: `prodigi/phases.md:284-286` specifies `src/app/api/admin/retry-fulfilment/route.ts`; route absent. `process-job.ts:123` claim set excludes `failed_action_required`; partial index `fulfilment_jobs_order_unique` blocks a second active job per order until the terminal row is cancelled.
- Why it matters: Asset/revoke failures land in `failed_action_required` with no self-service recovery path — manual DB status edit + re-queue.
- Recommended fix: Implement the planned admin retry route (or `orders-cli` mutation) for `failed_retryable` / `failed_action_required`.

**M-8 — `reconcile-orders` is ceramic-only**

- Category: Operational readiness
- Evidence: `scripts/reconcile-orders.mjs:3-4` — "missed transactional emails and stuck **InPost** shipments"; grep finds zero `prodigi`/`fulfilment` references. Print email backfill for order confirmation is handled, but no enqueue/callback/Prodigi backfill.
- Why it matters: Missed `enqueueProdigi` or stuck `failed_retryable` jobs have no operator backfill script (unlike ceramic email/shipment reconcile).
- Recommended fix: Extend reconcile with `--prodigi` flag: re-enqueue for paid print orders with no terminal job, or alert on `failed_action_required`.

**B-1 — Multi-frame carts undercharge shipping (acknowledged in code)**

- Category: Business / margin
- Evidence: `checkout/route.ts:114-126` logs `print_multi_frame_flat_shipping` when `framedCount > 1` but charges flat `printShippingOf()` once. Comment cites settled decision #5 — observability only until live `/quotes`.
- Why it matters: Not a test gap; a known margin leak on multi-frame orders.
- Recommended fix: Revisit when order volume warrants Prodigi quote-at-checkout.

**B-2 — 409 duplicate without order id leaves orphan DB state**

- Category: Fulfilment state machine
- Evidence: `process-job.ts:199-203` — job → `fulfilment_submitted` with message "id unknown", **no `prodigi_orders` insert**. Recovery depends on callbacks resolving via `merchantReference` (`callbacks.ts:108-134`).
- Why it matters: If callbacks are delayed or fail, ops tooling (`orders-cli`) shows a submitted job with no Prodigi id until manual lookup.
- Recommended fix: On 409-without-id, call `getOrder` by `merchantReference` or idempotency key before marking submitted; or alert studio.

**B-3 — Shipping email exhaustion marks callback event `done`**

- Category: Reliability (partially mitigated)
- Evidence: `callbacks.ts:165-176` — `sendPrintShippingEmailOnce` runs, then event → `done` unconditionally. On send failure after 3 attempts, claim on `shipping_email_sent_at` **is** released (`callbacks.ts:243-251`) and Sentry fires — but the same `provider_event_id` will hit "Already processed" (`callbacks.ts:58`) and never retry email.
- Why it matters: Lost tracking email until manual `resend-confirmation` or a **different** Prodigi callback event id arrives.
- Nuance vs missing-scenario #9 in original audit: claim-release exists; the gap is event-level dedup blocking replay of the same event.
- Recommended fix: Mark event `failed` (not `done`) when email send exhausts retries, or add shipping-email to `reconcile-orders`.

**S-1 — Callback token travels in URL path (intentional)**

- Category: Security / hygiene
- Evidence: `mapper.ts:119-121` — Prodigi accepts only plain `callbackUrl`; token is path segment. Documented constraint, not a bug.
- Why it matters: Token may appear in access logs, Prodigi systems, error reports. Mitigation: high-entropy token, never log full callback URLs.
- Recommended fix: Document in runbook; consider log scrubbing for `/api/webhooks/prodigi/`.

**O-1 — `failed_action_required` has no automated alert**

- Category: Observability
- Evidence: Terminal `failed_action_required` jobs set `last_error` in DB but no Sentry/email (contrast `cancel-print.ts` studio alerts). `check-print-fulfilment-jobs.ts` is manual/on-demand only — no cron binding in `worker.ts`.
- Recommended fix: Cron sweep (extend abandoned-order cron or new trigger) for non-terminal print jobs + `failed_action_required` → studio email.

### Revised remediation priority

Insert after original item 3, before pgTAP:

- **M-6** (admin Prodigi visibility) and **O-1** (alert on `failed_action_required`) — same effort band as DLQ consumer, highest ops impact alongside M-5.
- **M-7** before destructive E2E fulfilment assertions — operators need retry before E2E can fail usefully in sandbox.
- **M-8** / **B-3** — extend `reconcile-orders` once retry exists.

Original order 1 → 2 → 3 → **M-6/O-1** → 4 → 7 → 6 → **M-7** → 5 → 8 remains sound; add B-2 investigation when implementing H-1 contract tests.

