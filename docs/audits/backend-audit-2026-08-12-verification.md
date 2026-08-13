# Backend Audit 2026-08-12 — Verification Log

Live read-only evidence settling the `[UNVERIFIED]`/`[INFERENCE]`/§15 gaps from `backend-audit-2026-08-12.md`. This is the deliverable of **Plan 04** (`docs/superpowers/plans/2026-08-12-remediation-04-live-config-verification.md`); it is appended to as gates are checked. **No system was mutated** to produce any entry here — all checks are read-only API/CLI reads.

Legend: **CLOSED** = settled, no action · **ACTION** = settled, feeds a downstream plan · **OPEN** = not yet checked.

---

## Cloudflare-side gates — verified 2026-08-12

Access confirmed via `wrangler` OAuth (konrad.ciok@gmail.com, account `3ebc59b80b15b6b4850ae0734a24ce26`) and the Cloudflare API MCP (separate OAuth). Wrangler token covers workers/secrets/tail/queues/d1/zone-read + R2 reads; it does **not** carry an `access` scope, so the Zero Trust Access policy was read via the Cloudflare API MCP.

| Gate | Finding / §15 | Check | Result | Status |
|---|---|---|---|---|
| Plan 04 T2 | **M-6** (admin allowlist fail-open) | `wrangler secret list` + Access API `GET /accounts/{acct}/access/apps` + `.../policies` | Access app `anna-ciok.studio` (id `f78f44a5…`) covers `anna-ciok.studio/admin` **and** `/api/admin`; single **allow** policy `include` = exactly `ania@ciok.art`, `konrad@ciok.art` (no exclude/require). `ADMIN_ALLOWED_EMAILS` is **NOT set** in prod. | **ACTION** |
| Plan 04 T4a | **L-25** (R2 **direct** public-access posture) | `wrangler r2 bucket dev-url get` + `... domain list anna-ciok-print-assets` | `r2.dev` public access **disabled**; **no** custom domains attached → no direct public endpoint bypasses the signed route. | **CLOSED** |
| Plan 04 T4b | **L-25** (application-mediated access + S3-token scope) | — | **NOT proven by the above.** These checks show only that no *direct* public endpoint exists; they do **not** confirm (a) the deployed Worker actually serves the bucket exclusively via the HMAC-gated `/api/print-assets/[id]` route, nor (b) that the operator S3 API token is scoped to this bucket only. Record separately when checked (dashboard token-scope review + a route-serving assertion). | **OPEN** |
| Plan 04 T6 | **§15.9** (prod secret presence) | `wrangler secret list` (names only) | 36 secrets. All runtime-required names present **except `ADMIN_ALLOWED_EMAILS`** (see M-6). `FULFILMENT_DEBUG_TOKEN`, `ADMIN_SUPABASE_URL`, `ADMIN_STRIPE_SECRET_KEY` correctly **absent**. | **ACTION** |
| Plan 03 T3 | §15.9 (worker-alert prereqs) | `wrangler secret list` | `SENTRY_DSN`, `RESEND_API_KEY`, `STUDIO_NOTIFY_EMAIL` all **present** → the new worker-context alerts (Plan 03) and the DLQ email have somewhere to go. | **CLOSED** |

### M-6 adjudication (severity + downstream action)
**Stays LOW**, exactly as the audit assessed. The code-level allowlist is fail-open (`ADMIN_ALLOWED_EMAILS` unset), **but** the Cloudflare Access **perimeter policy is narrow** — only the two named studio emails can reach `/admin`|`/api/admin` at all; everyone else is rejected at the edge before the request hits the worker. The fail-open allowlist is therefore defense-in-depth behind a narrow perimeter, not an open door.

**Downstream action (Plan 09):** when landing the fail-closed allowlist change, set `ADMIN_ALLOWED_EMAILS="ania@ciok.art,konrad@ciok.art"` **in the same rollout** (before/with the code) so the two layers agree and the operator is not locked out. Sequencing gate — do not merge the fail-closed change without the secret set.

**Observation (not part of M-6):** the `anna-ciok.studio` Access policy has no `require` (no login-method/MFA requirement), whereas the sibling `casalimon-api-admin` app requires a specific `login_method`. Worth considering adding MFA to the admin policy — tracked here as an optional hardening idea, not an audit finding.

---

## Plan 01 gates (Stripe refund reconciliation) — verified 2026-08-13

Read-only evidence gathered while implementing Plan 01 (branch `fix/stripe-refund-reconciliation-c1`). Live-mode reads via the Stripe MCP connector (account `acct_1Qiwd0J0KFK9lrjH`, Anna Ciok Studio); test-mode reads via the local `sk_test_` key in `.dev.vars` (the only key available locally — no live secret key exists on this machine).

| Gate | Finding / §15 | Check | Result | Status |
|---|---|---|---|---|
| Plan 01 T5 pre-check | **C-1** (live `enabled_events`) | `GET /v1/webhook_endpoints` (livemode, MCP) | Single live endpoint `we_1TgXEgJ0KFK9lrjHNbgIUSbr` → `https://anna-ciok.studio/api/stripe/webhook`, `api_version 2026-05-27.dahlia` (matches SDK pin), `enabled_events` = `payment_intent.{succeeded,canceled,payment_failed,created,processing,requires_action}`, `charge.dispute.{closed,created}`, `charge.captured` — **`charge.refunded` and `refund.failed` both missing**, exactly as the audit found. | **CLOSED** — gate executed, see below |
| Plan 01 T5 pre-check | **C-1** (damage still standing) | `npm run orders -- order get 8be30881…` (prod Supabase, PII-redacted) + `GET /v1/refunds?payment_intent=pi_3Tw1WW…` (livemode, MCP) | Order `8be30881-4f02-44a6-9627-221f54c67125` still `status='paid'`; piece `s15` still `sold` (order_id matches); refund `pyr_1Tw3aZJ0KFK9lrjHTvwyQoly` **succeeded, full 13 900 gr (139 zł), BLIK**. Un-reconciled as of 2026-08-13 — backfill still required (Task 5 gate 2). | **CLOSED** — gate executed, see below |
| §15.1 | Stripe **v2 Event Destinations** | `GET /v2/core/event_destinations` (test-mode key) + livemode inference | **Test mode:** 2 destinations — `ed_test_61Unzq…` (thin payload, only `v2.core.account_*` events) and the v2 mirror of legacy endpoint `we_1TebsmJ4XAbcEQUuEK9nt0RX` (snapshot, has `charge.refunded`, missing `refund.failed`). **No test-mode v2 destination independently re-adds `charge.refunded`.** **Live mode:** not directly listable read-only from this machine (no live key locally; the MCP connector exposes no v2 operations) — but the livemode v1 list shows exactly one endpoint (above), and the DB proof (a succeeded 2026-07-22 full refund left the order `paid`) rules out any *working* alternative `charge.refunded` delivery path to the storefront. Fix target stays "subscribe the event on `we_1TgXEg…`". Operator: glance at Dashboard → Event destinations during the gate as final confirmation. | **CLOSED** |
| Plan 01 T5 post-check tooling | Opp-2 | `npm run orders -- webhook-config-check` (test-mode key) | New drift guard ran against the test-mode account: correctly flagged `we_1Tebsm…` missing `refund.failed` (exit 4, `webhook_config_drift`). Post-gate confirmation against live requires a live key in the loaded env (`ADMIN_STRIPE_SECRET_KEY` or `STRIPE_SECRET_KEY`). | **CLOSED** (tooling verified) |

### Plan 01 live gates — EXECUTED 2026-08-13 (operator-approved)

Operator (konrad.ciok@gmail.com) approved both gates and provided a live key (`STRIPE_SECRET_LIVE_KEY` in local `.dev.vars`); decision recorded: **`s15` does NOT return to sale**.

| Gate | Mutation | Pre-state | Post-state | Result |
|---|---|---|---|---|
| 1 | `POST /v1/webhook_endpoints/we_1TgXEg…` — `enabled_events` += `charge.refunded`, `refund.failed` (full 11-event replacement list) | `webhook-config-check` (test key) failing; live list missing both events | HTTP 200; `npm run orders -- webhook-config-check` **with the live key: PASS** (`missingRequired: []`, `apiVersionMismatch: null`; the 5 known no-op events reported as `subscribedButUnhandled` warnings — left subscribed per plan) | ✅ From this moment every new refund converges automatically |
| 2 | `reconcile-refunds --confirm 8be30881-4f02-44a6-9627-221f54c67125 --skip-relist` (prod Supabase) | Dry-run listed exactly this order (`status_not_refunded`, `pieces_still_sold: [s15]`; `followUps: []` — `conversions_sent_at` null, so no GA4 reversal owed) | Order CAS `paid→refunded` ✅; `s15` converged to **terminal off-sale state `sold` + `order_id NULL`** (same terminal state `releaseSale` gives private-sale pieces) per the operator decision; `requiredFollowUps: []`, `converged: true`. Final dry-run: **`unreconciled: []`, `converged: 1`** | ✅ Acceptance criterion met |

Note: during gate 2 the original `--skip-relist` semantics ("leave `piece_state` untouched") proved self-contradictory with the plan's own acceptance criterion (a piece left `sold` with `order_id` set is indistinguishable from a crashed release, so the dry-run re-flagged the order forever). Amended in the same PR: `--skip-relist` now records the decision by converging pieces to the private-sale terminal state (`sold`, detached). 

---

## Plan 05 — print-pipeline production rehearsal (L-15 / L-22 / §15.2 / §15.8) — executed 2026-08-13

Branch `fix/print-pipeline-rehearsal-l15` (off `main` @ `bd41732`, Plans 01–03 all merged). Operator (konrad.ciok@gmail.com) **acknowledged the shared-Supabase gate** before any write: preview points at the production Supabase project; all rehearsal rows are test rows tracked in the cleanup list below. All times UTC.

### Environment (Task 1)

Preview worker **`ceramics-drop-preview`** (wrangler `env.preview`, workers.dev only) with **dedicated queues** `prodigi-fulfilment-preview` (max_retries **3** — prod keeps 10; chosen so the DLQ drill completes in minutes, same backoff→DLQ path) + `prodigi-fulfilment-preview-dlq`, cron `*/15`, same R2 bucket (reads only), `WORKER_ORIGIN` = preview URL.

| Env var | Designation |
|---|---|
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` | Stripe **test mode** (dedicated test webhook endpoint `we_1U3yZQ…` → preview URL, 11 events incl. `charge.refunded`+`refund.failed`, api_version `2026-05-27.dahlia`) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | **production project** (operator-acknowledged; test rows only) |
| `PRODIGI_API_KEY_SANDBOX`, `PRODIGI_ENV=sandbox` | Prodigi **sandbox** |
| `PRODIGI_CALLBACK_TOKEN`, `PRINT_ASSET_TOKEN_SECRET` | same values as local dev (preview-scope usage) |
| `RESEND_API_KEY`, `STUDIO_NOTIFY_EMAIL` | real Resend, studio inbox |
| `SENTRY_DSN` | project DSN (events tagged from the preview host) |
| `FULFILMENT_DEBUG_TOKEN` | freshly generated, preview-only (prod: confirmed absent — Plan 04 T6) |
| `PRODIGI_API_BASE_URL` | drill only (Task 3), removed after |

**Harness changes shipped on this branch (in-scope per plan):** (1) `PRODIGI_API_BASE_URL` sandbox-only override in `src/server/prodigi/client.ts` + 3 unit tests — live mode returns before the override is read, so production traffic provably cannot be redirected; (2) DLQ routing by `-dlq` suffix (`isDlqQueue`) — queue names are account-unique, so the previous exact-match on the prod DLQ name silently fed any non-prod DLQ back into `processJob`; (3) `env.preview` block in `wrangler.jsonc`.

### ⚠️ Incident during Task 1 (resolved, ~5–7 min)

The first preview deploy **inherited the top-level custom domains** (`wrangler` env-inheritance default) and reassigned `anna-ciok.studio` + `www` to the secret-less preview worker. Detected in the deploy output; both domains reattached to `ceramics-drop` via the Cloudflare API (`PUT /workers/domains`, `override_existing_origin`) and verified (`/api/inventory` serving live data again; domain list shows `ceramics-drop`). Static/cached pages served 200 throughout; blast radius was dynamic routes for ~5–7 min. Guard now in config: `env.preview.routes: []` with a warning comment. **Lesson recorded:** any future wrangler env addition must explicitly empty `routes`.

### Task 2 — happy path (one print purchase, real queue runtime)

Driver: destructive print E2E (`e2e/print-purchase.spec.ts @destructive`) against the preview; payment via Stripe test card. Test order `55af24b2…` (buyer `e2e***@example.com`, fap005 50×70 framed black, 726 zł PLN).

| Stage | Evidence (redacted) | Result |
|---|---|---|
| Webhook receipt + ledger | `webhook_events`: `payment_intent.succeeded` → **`done`** 13:23:57 (`payment_intent.created` also `done`) | ✅ |
| markPaid + studio email | order `paid`; studio new-order email **delivered** 13:24:00 (Resend `4d8c0391…`). Buyer confirmation email failed **Resend 422** (`@example.com` refused by Resend — test-harness artifact, not a pipeline fault; `confirmation_email_sent_at` stays unclaimed as designed) | ✅ (with expected test artifact) |
| Enqueue → **real queue** | `fulfilment_jobs` `b758e881…` created 13:24:06; tail shows queue-consumer invocation `event.queue = prodigi-fulfilment-preview`, batchSize 1; **zero `fulfilment_inline_fallback` warns** in the entire capture | ✅ §15.2 / C-2 post-fix proof — queue-context Supabase client works |
| processJob → Prodigi sandbox | tail: `processJob … signing 1 asset(s) … rev 2026-08-04-r1`; job → **`fulfilment_submitted`** (attempts 1); `prodigi_orders` row 13:24:12 → sandbox **`ord_1167165`**, stage `InProgress` | ✅ |
| Asset delivery to Prodigi | Prodigi pulled the HMAC-signed preview URL (`/api/print-assets/…`, `sig` redacted); asset `status: Complete`, md5 recorded; one follow-up GET client-cancelled (benign thumbnail refetch) | ✅ |
| Debug endpoint (H-2 surface) | `GET /api/debug/fulfilment-status?payment_intent=pi_3U3ybt…` → `{"fulfilmentStatus":"fulfilment_submitted","prodigiOrderId":"ord_1167165"}`; gate verified 401 wrong token / 404 no token | ✅ |

Observations: (a) an **orphan PI create+cancel pair** (`evt_3U3yc3…`, no order row) appeared 10 s after payment — both events processed `done`, `releaseHold` on an unknown PI is a clean no-op; (b) the E2E's own final poll failed because the return page cleans `payment_intent_client_secret` from the URL before the spec reads it — **E2E spec race, filed below (F-3)**.

### Task 4 — refund leg (test mode; joint Plan 01 E2E evidence)

Pre-state: order `55af24b2…` `paid`; sandbox `ord_1167165` active (`InProgress`, `inProduction: InProgress`, shipping `NotStarted`).

Full test-mode refund `re_…HftmqmH` (72 600 gr) issued 13:28. Results:

- `charge.refunded` delivered to the preview endpoint → `webhook_events` **`done`** 13:28:02 → order CAS paid→**`refunded`** — **Plan 01's `charge.refunded` subscription proven end-to-end in test mode.** `refund.failed` correctly did not fire.
- **Refund-triggered print-cancel path ran** (webhook `releaseSale` → `cancelPrintFulfilment`, claim `cancel_alerted_at` 13:28:03): Prodigi reported **cancel unavailable** (sandbox order entered production within ~4 min of creation), so the code took the designed `manual_cancel_required` path: Sentry warning **`print_refund_manual_cancel_required`** (issue `CERAMICS-DROP-1J`, 13:28:04) + studio alert email **delivered** 13:28:05 (Resend `a11dcc45…`, „[Zwrot] Druk zwrócony — anuluj w Prodigi…”). The plan's "assert cancelled-by-refund" expectation was **superseded by observed sandbox reality**: the path executed and alerted loudly; an actual `Cancelled` flip requires refunding before Prodigi allocates production (~seconds–minutes).
- GA4 refund reversal correctly not owed (no consent/`conversions_sent_at` on the test order).

### Findings (recorded, NOT fixed here)

| # | Severity | Finding | Owner |
|---|---|---|---|
| **F-1** | **HIGH** | **Prodigi status callbacks are rejected with HTTP 400.** Two real sandbox callbacks (13:28:05) hit `/api/webhooks/prodigi/[token]` and got 400 before any ledger write (no `webhook_events` rows, no logs). Cause: `handleProdigiCallback` requires `data.prodigiOrderId`, but Prodigi CloudEvents carry the order as `data.order` (id inside). In production: no stage updates, no tracking columns, **no customer shipping email**, and zero observability (a 400'd callback leaves no trace). L-22 exactly as feared. | Plan 11 |
| F-2 | MED (ops) | Sandbox order became **uncancellable ~4 min after submission** (production allocation). Post-submission refunds will routinely land in `manual_cancel_required` → the studio alert email is the real mechanism, not the automatic cancel. Runbook expectation should say so. | Plan 11 / runbook |
| F-3 | LOW | Destructive print E2E reads `payment_intent_client_secret` from the URL **after** the success assertion; the return page has already cleaned the URL → spec fails despite a healthy pipeline. Poll key should be captured earlier (or read from sessionStorage). | Plan 12 |
| F-4 | INFO (L-22) | `recipientCost` returned in **EUR** (`155.69 EUR`) for a PLN-charged order — the audit's "PLN recipientCost" assumption does not hold; Prodigi quotes merchant cost in its own currency. No 409-idempotency case arose (fresh order, single delivery). | Plan 11 |
| F-5 | INFO (§6.11) | Top-level sandbox stage stayed **`InProgress`** with `details.inProduction: InProgress` — no separate `InProduction` top-level stage observed pre-cancel-window. Callback-driven stage evidence was cut short by F-1; §6.11 stays **open** until callbacks parse (retest after Plan 11 fixes F-1). | Plan 11 T6 |

### Task 3 — failure path (alerts are loud)

Injection: `PRODIGI_API_BASE_URL=https://prodigi-drill.invalid/v4.0` (preview secret; the override cannot affect live — unit-tested). Classification pre-asserted by existing green tests (`retryable:true → 'retry'`; client maps network/5xx to retryable). Second test purchase (order `c5c57a0b…`, job `2b5660a9…`) 13:34:09 — Cloudflare fetch returned **530/1016** for the `.invalid` host → `ProdigiError` retryable.

| Stage | Evidence (redacted) | Result |
|---|---|---|
| Retries with backoff (M-23) | tail: `fulfilment_queue_error` attempts 1 and 2, `disposition:"retry"`, `errorStatus:530`; delays consistent with `min(2^attempts×30 s, 1 h)` (60 s → 120 s → 240 s); job `2b5660a9…` `failed_retryable`, `last_error: ProdigiError: Prodigi 530` | ✅ |
| DLQ delivery + routing | 13:41:23 — consumer invocation on `prodigi-fulfilment-preview-dlq` handled by the DLQ (alert-only) branch via the new `isDlqQueue` suffix routing; `prodigi_dlq_message` structured log with orderId/jobId/bodySnippet. Cosmetic: the alert payload's `queue` field prints the hardcoded prod constant, not the actual queue name | ✅ |
| DLQ studio email | **Delivered** 13:41:23 — „[DLQ] Prodigi — 1 wiadomość/i…” (Resend `02bfcdf1…`) | ✅ |
| **Worker-context Sentry (M-16 live proof)** | `prodigi_dlq_poison_message` (level error) captured **from the queue consumer context** via `captureWorkerAlert` — issue `CERAMICS-DROP-1K`, 13:41:23. Plan 03's envelope-POST path works where `@sentry/nextjs` no-ops | ✅ |
| Stalled-job sweep (M-10) | Drill job's `created_at` backdated −3 h by SQL (code untouched, per plan; true value `13:34:09.065964` restored in cleanup) → next `*/15` cron tick (13:46:00): `stranded_alerted_at` claimed; **TWO** studio emails delivered (prod worker → `studio@ciok.art`, preview worker → `konrad@ciok.art` — both crons swept the shared table in the same minute before either marked, the documented email-before-mark trade-off demonstrated live, and free proof that **prod's own M-10 sweep works**); Sentry `fulfilment_job_stranded` (warning, issue `CERAMICS-DROP-1M`, scheduled-context `captureWorkerAlert`) | ✅ |

Post-drill: injection secret removed; drill order `c5c57a0b…` fully refunded in test mode → `charge.refunded` → `done`, order `refunded`, and `cancelPrintFulfilment`'s **in-flight branch** cancelled the `failed_retryable` job (`cancelled`, „order refunded mid-submission — check Prodigi manually”) — the third cancel branch exercised.

### Cleanup (Task 5)

Executed 2026-08-13 ~13:50–13:55 UTC:

- **Test rows kept, annotated here** (deliberate — deleting would orphan FK'd evidence): orders `55af24b2…` and `c5c57a0b…` both terminal `refunded`; jobs `b758e881…` (`fulfilment_submitted`) and `2b5660a9…` (`cancelled`, true `created_at` restored after the backdate test); `prodigi_orders` row for `ord_1167165` (stage frozen `InProgress` due to F-1; real sandbox stage `Complete`). No `piece_state` rows were ever touched (print orders don't reserve pieces).
- Sandbox order `ord_1167165`: cancel attempted → `ActionNotAvailable` (sandbox auto-ran to `Complete`); no cost, nothing ships from sandbox. Second drill order never reached Prodigi (injection active).
- `PRODIGI_API_BASE_URL` removed from the preview before teardown; then the **entire preview worker deleted** (its secrets, incl. the preview `FULFILMENT_DEBUG_TOKEN` and prod-DB service key, died with it), both preview queues deleted, the test-mode Stripe webhook endpoint `we_1U3yZQ…` deleted. Verified: preview URL → Cloudflare 1042; prod domains on `ceramics-drop`; prod `/api/inventory` 200. Re-rehearsal is cheap: the `env.preview` config remains in `wrangler.jsonc`.
- Prod secret sweep cross-check (Plan 04 T6): `FULFILMENT_DEBUG_TOKEN` confirmed **absent** from prod — unchanged.
- **Post-rehearsal (operator-approved):** the 5 Sentry issues raised by the rehearsal (`…-1G/1H/1J/1K/1M`) resolved with explanatory comments, and the **legacy test-mode Stripe endpoint `we_1Tebsm…` deleted** — it pointed at the prod URL, so every test-mode event bounced off the live signing secret as `stripe_webhook_bad_signature` noise (7 events during the rehearsal; the fail-safe itself worked). §15.1's test-mode endpoint inventory is now: none.

### Go / No-Go

**Verdict: CONDITIONAL GO — money-path GO, post-sale visibility NO-GO until F-1 lands.**

GO evidence: every forward stage ran green in the **real queue runtime** (webhook → ledger → queue → processJob → sandbox Prodigi order with asset delivery), and every alert channel proved **loud**: DLQ email + worker-context Sentry (M-16), stranded-job email + Sentry (M-10), refund manual-cancel email + Sentry, retries with backoff (M-23), zero inline fallbacks, ledger rows all terminal. The refund leg (Plan 01) converges orders and cancels/alerts print fulfilment in all three branches.

The blocking condition: **F-1 (Prodigi callbacks 400)** means that after a real sale the shop would take money, submit the order, and then go **blind** — no stage updates, no tracking, **no customer shipping email**, no trace of the rejected callbacks. That contradicts the audit's own no-go criterion ("any stage silently failed"). The stranded-job watchdog does NOT cover it (the job is already `fulfilment_submitted`, a terminal-enough status the sweep ignores). **Real print sales should wait for the Plan 11 callback-shape fix + a re-run of the callback leg of this rehearsal** (single sandbox order, ~15 min, config is in place). Everything else — checkout, payment, fulfilment submission, refunds, alerting — is proven and would not need re-testing.

Signed: rehearsal executed 2026-08-13 by Claude (Opus 4.8) with operator konrad.ciok@gmail.com approving the gates (preview architecture, shared-Supabase test rows, secret provisioning).

---

## Remaining gates — not yet checked (non-Cloudflare)

| Gate | Finding / §15 | Where it's checked | Status |
|---|---|---|---|
| Plan 04 T1 | **H-4** (admin-editor `supabaseUrl is required.`) | Sentry — read the issue's newest event host + release/env + timing | OPEN |
| Plan 04 T3 | **M-25** (Supabase key format) | Supabase dashboard — legacy JWT vs `sb_secret_`/`sb_publishable_` | OPEN |
| Plan 04 T5 | **H-2** (admin-gate encoded-path probes) | `curl` against a **preview** deploy (never prod) | OPEN |
| Plan 04 T7 | **L-40** (ceramic EUR/GBP display-vs-charge parity) | read-only SQL vs `PRICE_EUR`/`PRICE_GBP` constants | OPEN |
| §15.1 | Stripe **v2 Event Destinations** | Stripe Dashboard / `GET /v2/core/event_destinations` (folded into Plan 01 T5) | **CLOSED** — see Plan 01 section above |

---

*Prepared read-only. Entries are added as their owning plan (04/09/01/…) reaches the corresponding gate.*
