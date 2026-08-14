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

## Plan 11 — Prodigi robustness (F-1 / M-11 / M-12 / M-14 / M-26 / L-19 / L-24 / §6.11) — executed 2026-08-13

Branch `fix/prodigi-robustness-plan11` (off `main` @ `9b3b006`, Plan 05 merged). Implementation summary lives in the PR; this section records the **live evidence** and the settled gaps. All times UTC.

### Callback-leg re-test (preview, sandbox) — F-1 CLOSED ✅

Preview worker `ceramics-drop-preview` redeployed from the branch (`env.preview`, deploy output verified: workers.dev + cron + queue consumers ONLY, no custom-domain routes — prod `/api/inventory` 200 throughout). Dedicated queues recreated; secrets from local dev values; `SENTRY_DSN` deliberately omitted (short-lived preview, log-only). The two Plan 11 migrations were NOT pre-applied to prod — the callback merge doesn't read the new columns (verified live), so the leg tests cleanly without them.

Driver: synthetic test order `16fb092f-9bb7-4509-a67c-86c9aed106e7` (terminal `refunded` from insert, 0 total, buyer `delivered@resend.dev`) + one sandbox order created via `npm run prodigi -- order create` with `callbackUrl` → the preview route and `merchantReference` → the synthetic order. Sandbox order **`ord_1167177`** (fap005 4800×7200 asset `3be45c3e…`, `GLOBAL-CFP-20X28` framed black; asset URL signed against the preview origin — HEAD 200 `image/jpeg`, the DB-validated content type per L-24).

| Evidence | Result |
|---|---|
| Real Prodigi CloudEvents parsed (the F-1 failure mode) | **6/6 events → `done`** in `webhook_events`: `stage.changed#Draft` ×2 (`evt_1050826`, `evt_1050829`), `#InProgress` ×2 (`evt_1050827`, `evt_1050830`), `shipments.shipment#Complete` (`evt_1050843`), `stage.changed#Complete` (`evt_1050847`). Zero 400s, zero `prodigi_callback_rejected` lines. In the pre-fix code every one of these would have bounced 400 traceless. |
| Local order resolution | `prodigi_orders` row created with `order_id = 16fb092f…` resolved via `merchantReference` (no pre-existing mapping row — the fallback path). |
| Stage + tracking persistence | `prodigi_status_stage: Complete`, `carrier: DPD NL`, `tracking_number: PH000000000GB`, `shipped_at: 2026-08-13T15:45:06.5Z` (from Prodigi `dispatchDate`). |
| Customer shipping email (5b leg) | claim `shipping_email_sent_at 15:46:06`; Resend `4701bbd8-05b3-4f48-b7fe-00dca3371d36` „Twoje zamówienie zostało wysłane” → `delivered@resend.dev` **status: delivered** 15:46:06. |
| M-14 redaction on a real payload | persisted `prodigi_raw_json`: **no `sig` value present**, `[REDACTED]` marker present, `exp` kept. |
| Token gate | callbacks for a first, mis-built order (`ord_1167176`, callbackUrl carried literal quotes from a tooling bug; order cancelled cleanly — `outcome: Cancelled` inside the pre-production window) bounced off the token gate as designed. |

**Tooling gotcha recorded:** two `.dev.vars` values (`PRODIGI_CALLBACK_TOKEN`, `PRINT_ASSET_TOKEN_SECRET`) are double-quoted — any `grep|cut → wrangler secret put` pipeline must strip the quotes or the deployed secret (and anything derived from it, like a callback URL) silently carries literal `"` characters.

### §6.11 / F-5 — SETTLED

Observed top-level stages across the retest callbacks: `Draft`, `InProgress`, `Complete` (plus the `shipments.shipment#Complete` event type). **No top-level `InProduction` exists in v4** (matches the docs' stage list); production progress moves only under `status.details.*`. The dead `InProduction → 'in_production'` mapping was removed; `Draft` (not in the docs' list either, but observed live) falls into the unknown→null no-op branch by design. F-4/L-22 (merchant-currency money fields) and F-2 (post-submission refunds routinely `manual_cancel_required`) are recorded in `types.ts` / `docs/orders-cli.md`.

### Adversarial review

A 4-lens multi-agent review ran against the branch diff; Anthropic API overload (529) killed 3 lenses and all dedicated verifiers, but the **correctness/concurrency lens completed with 5 findings — each manually verified against the code and all 5 fixed** in commit `1a6a65a` (cron-safe shipping email env injection; `status.details`-aware progress + stall threshold 2→8 polls ≈ 48 h; env-flip guard for delivered jobs; 4xx re-fetch denial alerts; job-before-stage write ordering in the merge). Residual: the security/reliability/regression lenses never produced output — M-14 redaction and the §6.11/regression surface were checked manually with live evidence above; a re-run (e.g. `/code-review ultra`) is cheap if desired.

### Cleanup

Preview worker deleted (URL → 404; its secrets died with it), both preview queues deleted (`wrangler queues list` clean), tail stopped, prod domains + `/api/inventory` 200 verified after every step. Test rows kept-annotated (Plan 05 convention): order `16fb092f…` (terminal `refunded`), its `prodigi_orders` row (`ord_1167177`, terminal `Complete`), 6 `webhook_events` rows (`done`). Sandbox orders cost nothing and ship nothing.

### Post-merge follow-ups (operator)

1. **M-12 live proof:** the rehearsal's frozen row `ord_1167165` (stage `InProgress` in DB; real sandbox stage `Complete`) is the natural fixture — within ~30 min of the merge deploying (migrations auto-apply first), the prod reconciliation sweep should advance it to `Complete`. Expected artifacts: one `prodigi_reconcile_sweep_done` log with `progressed: 1`, and one failed shipping-email attempt for the `@example.com` rehearsal buyer (Resend 422 — benign, row then terminal).
2. Watch the first REAL print order's callbacks: `webhook_events` rows `done`, redacted raw JSON, tracking columns, customer email.

**Verdict: the Plan 05 blocking condition is cleared** — real print sales are unblocked once this PR merges (the money path was already GO).

Signed: executed 2026-08-13 by Claude (Fable 5), operator konrad.ciok@gmail.com (standing gates from Plan 05: preview architecture, shared-Supabase test rows, sandbox mutations).

---

## Plan 06 — Stripe webhook hardening (H-1 / M-5 / M-21 / M-22 / M-27 / L-4 / L-5 / L-6 / L-7) — executed 2026-08-13

Branch `fix/stripe-webhook-hardening-plan06` (off `main` @ `4827afb`, Plans 01–03/05/11 merged). **No external system was mutated** — this plan has no live gate; validation is local/unit (per the plan: local + preview + live *read-only*; the preview/live-watch legs are post-merge operator steps, below). M-20 (ack-fast rearchitecture) stays **DEFERRED** by design.

### What landed (per finding)

| Finding | Change | Evidence (tests) |
|---|---|---|
| **H-1** | The reserved→sold `piece_state` UPDATE in `markPaid` now destructures + throws — a transient DB failure can no longer read as under-fulfilment and **auto-refund a legitimate payment** with a 200 | route: sold-UPDATE error → throw, `refunds.create` NOT called *(1)* |
| **M-5** | `23505` from `private_sales_one_paid_order` on the pending→paid CAS now runs a crash-safe **refund-then-fail** machine: durable `refund_pending_at` marker (CAS on `pending`) → `refunds.create` under the shared `refund_<pi>` key (`charge_already_refunded` after key expiry = success) → stranded reserved pieces converge to the private-sale terminal `sold` → `pending→failed` CAS clears the marker → Sentry `private_sale_double_paid` + studio email → 200. Zero-row marker/final CAS classify first; only `failed`/`refunded` ack — anything else throws. | route M-5 block: (a) marker **before** refund + refund-once w/ key; (b) terminal `failed` + marker cleared + piece convergence + alert; (e) already-refunded = success; (f)/(f2) zero-row marker over `failed`/`refunded` → **no refund**, 200; (g)/(g2) unaccountable state → throw; (h) non-23505 → throw *(8)* |
| **M-5 consumer guard** | New nullable `orders.refund_pending_at` + `orders.expiry_claim_at` (migration `20260813160000`). Pending consumers claim a **recoverable lease** (`claimExpiryLease`: `status='pending' AND refund_pending_at IS NULL AND (lease null or stale >10 min)`) BEFORE their irreversible side effects; terminal `pending→expired` is **fenced to the claimant's own token**. `worker.ts` cron: claim → PI cancel → fenced CAS (failure ⇒ order stays `pending`, next tick reclaims). `admin releaseReservation`: claim → cancel → piece release → fenced CAS, **own lease handed back on every failure exit** so an immediate admin retry completes. | expire-orders: claim-denied skip; claim-precedes-cancel; cancel-fails → next sweep reclaims+succeeds *(3)* · `claimExpiryLease`/`releaseExpiryLease` predicate + CAS unit tests *(5)* · actions: claim-denied 409 (marker set **after** the initial read); claim-precedes-cancel; release-failure → 500 + lease back + retry completes; lease-fenced terminal CAS filters; lease-back on 409/502; non-pending skips claim *(6)* |
| **M-5 `failed`-state contract** | `customerOrderStatus` maps `failed` → `cancelled` (never a delivery state). Confirmed & pinned: account list/detail exclude non-`paid`/`refunded` at SQL level; ceramic fulfilment skips non-paid (existing); print worker `failed_action_required`s non-paid (existing); conversions return unless `paid` (existing). | status: failed→cancelled ×3 shapes *(1)* · account orders list/detail filter pinned *(2)* · route `skips fulfilment for non-paid` + process-job `order not paid` *(pre-existing, confirmed)* |
| **M-21** | seen-SELECT error now **throws** (was: dropped → insert branch → 23505 → false dedupe-200) | route: seen-error → 5xx *(1)* |
| **M-22** | Dedupe-200 reserved for a `done` row; **all four claim-loser paths 409** (`{ received: false, inFlight: true }`): active lease, lost claim-CAS, insert-23505 over a non-`done` row (re-read added), stale row not reclaimed. Stripe-visible: concurrent duplicates now log as failed attempts that later succeed — expected. | route: active lease → 409; CAS-lost → 409; insert-race non-done → 409; insert-race done → 200; done row → 200 *(5)* |
| **L-4** | `releaseLease` and the done-write CAS on `.eq('processing_started_at', claimedAt)` — a stale releaser writes nothing | route: both writes assert the claim-scoped filter *(2 asserts)* |
| **L-6** | `charge.dispute.created` branch + `HANDLED_STRIPE_EVENTS` entry (drift guard now **requires** the subscription — already live per Plan 01 T5). Deadline-bearing studio email (subject carries `evidence_details.due_by`) + Sentry `stripe_dispute_created`; send allowed to throw → Stripe retries the alert | webhook: branch + drift-table entry *(2)* · route: alert wiring incl. due_by, failed send → 5xx *(2)* · email builder: deadline in subject/body, degraded nulls *(2)* |
| **L-5** | `ensureInvoiced` keeps the swallow (Stripe still gets 200) but now also emails the studio; the alert itself is best-effort | route: invoice failure → alert + 200; failing alert email still 200 *(2)* |
| **L-7** | Every `console.error`-only catch on the markPaid post-processing path upgraded to Sentry — **N = 5**: (1) post-processing catch; (2) `sendEmailOnceWithClaim` claim failure (`email_claim_failed`); (3) claim-release failure (`email_claim_release_failed`); (4) conversions-claim failure (`conversions_claim_failed`); (5) `trackPurchase` outer catch. Deliberate console-only exceptions: `releaseLease` `.catch` (self-heals via TTL) and the two deferred `waitUntil` `.catch`es (impls Sentry their own real failures). | one regression per catch *(5)* |
| **M-27** | `Idempotency-Key` on `sendResendTemplate`/`sendResendHtml`; claim-based webhook senders thread `order-confirmation/<orderId>` + `studio-new-order/<orderId>`. Admin/CLI manual re-sends pass **no** key (24 h dedupe would swallow them). `studio-alert-email.ts` (cron/queue raw sender) consciously out of scope — alert duplicates are the documented, harmless trade-off. **Accepted residual:** Resend key lives 24 h vs Stripe's 3-day retries — an accepted-but-timed-out send retried >24 h later can still duplicate; revisit only if duplicates are observed. | email: both helpers send/omit the header *(4)* · route: fresh-sale threads both keys *(2 asserts)* |

### Verification

- `npm run lint` ✅ · `npm run typecheck` ✅ (app + worker tsconfig)
- Plan-touched suites: `npx vitest run src/app/api/stripe/webhook/route.test.ts src/lib/webhook.test.ts src/lib/email.test.ts src/lib/expire-orders.test.ts src/lib/account/status.test.ts src/lib/account/orders.test.ts src/lib/admin/actions.test.ts` → **243 passed (243)** (baseline before the branch: 188 — covering every enumerated task-level case above plus the review-driven additions; the gate is the enumerated list, not the count)
- Full `npm test`: 2005+ passed, 4 failed — the 4 known Windows-local failures (orders-cli, prodigi-cli ×2, auth session), all in files **untouched** by this branch (`git diff main --name-only` ∩ failing files = ∅); CI is the oracle.
- **Adversarial review (17-agent workflow: 4 lenses → per-finding refutation):** 12 confirmed findings (1 HIGH, 4 MEDIUM-class after dedup, rest LOW/test-gaps), 1 refuted — **all confirmed findings fixed on the branch before the PR**: (H) migration filename collided with Plan 11's applied `20260813150000_prodigi_orders_reconciliation.sql` → renamed `20260813160000`; (M) cron `expireOrder` went terminal before the piece release → extracted `finalizeExpiry` (pieces first, lease-fenced CAS last, unit-tested) mirroring the admin ordering; (M) a stale `refund_pending_at` marker (Stripe retries exhausted) was silently skipped forever → the sweep now fires the M-15 alert when a denied claim carries a marker older than 24 h; (M) M-5 CAS predicates untested → fixture now records + asserts the filter chains; (L) admin terminal-CAS error leaked the lease → handed back + test; (L) `releaseSale`'s pending→refunded CAS now clears `refund_pending_at`/`expiry_claim_at`; (L) the double-paid alert moved BEFORE the terminal CAS (isolate death after the CAS would silence the refund forever) with a `double-paid-alert/<orderId>` Resend key deduping crash-retries; (L) added test (g3) safe-ack leg. Residuals accepted: a failed alert *send* still only lands in Sentry (full durability would need an alerted_at claim column), and the two one-line worker dep wirings remain covered only via their extracted, unit-tested implementations.

### Post-merge operator steps (no live gate in this plan)

1. Migration `20260813160000` auto-applies on merge (~41 s, before the Workers deploy) — additive nullable columns, old code ignores them. **A code revert must RETAIN both columns.** (The adversarial review caught the original filename colliding with Plan 11's already-applied `20260813150000_prodigi_orders_reconciliation.sql` — renamed before the PR.)
2. Preview/live watch: drive one test-mode checkout (or observe the first live deliveries) — expect all 2xx, plus **expected 409-then-2xx pairs under concurrent redelivery** (M-22). Sustained 409s for the *same* event beyond ~5 min = stuck lease, investigate.
3. Any refund created by the M-5 path deserves a manual review (should be near-impossible).

---

## Plan 07 — Supabase data-API & schema hardening (M-2 / M-3 / M-4 / L-10 / L-12 / L-13) — executed 2026-08-14

Branch `fix/supabase-hardening-plan07` (off `main` @ `e71d519`, Plan 06 merged — 52 migrations at start, `20260813160000` the latest). **No external system was mutated** during implementation — this plan's only production mutation is the migration itself, which auto-applies on merge (the merge is the gate, per AGENTS.md; not run by hand). L-9/L-11/L-17/L-20 stay **DEFERRED** exactly as the plan specified — not touched.

### Tooling gap discovered (shapes both rulings below)

The connected Supabase MCP server exposed only a log-query tool in this session — no `execute_sql`/`list_tables`/`get_advisors`. No Supabase CLI access token, no direct Postgres connection string in local env; PostgREST doesn't expose `pg_catalog`. Result: Task 0's `pg_policy` read (exact live `piece_state` policy names) could not be done. Everything else in Task 0 (data checks, status enumeration) **was** done — those are normal `public`-schema reads, reachable via the existing service-role Supabase JS client, same access class as `npm run orders`/`npm run prodigi`.

### What landed (per finding)

| Finding | Change | Evidence (tests) |
|---|---|---|
| **M-2** | `revoke all/execute ... grant ... to service_role` (house 3-line idiom) on all four RPCs: `reserve_pieces`, `reserve_private_sale_pieces`, `publish_cms_version`, `publish_print_asset_revision` (4-arg — the only live signature). Every caller verified against source, not trusted: all four go through `service_role` clients. | pgTAP `has_function_privilege` × 12 (anon/authenticated deny, service_role allow) |
| **M-3** | `piece_state`'s two out-of-band anon-SELECT policies (advisor 0006, present live, in **zero** migrations) dropped via a dynamic `DO $$` block enumerating and dropping whatever policies actually exist — **not** hardcoded names (see Ruling below), schema-qualified to `public.piece_state` after task review. | pgTAP policy-count = 0 (vacuous on a fresh DB — only a post-merge live read proves the drop; see Post-merge below) |
| **L-10** | `p_ttl_secs := least(greatest(coalesce(p_ttl_secs, 900), 60), 3600)` added as the first statement in both `reserve_pieces`/`reserve_private_sale_pieces`, restated in full via `CREATE OR REPLACE` — diffed byte-identical against source migrations apart from the clamp line. | pgTAP: `-5` clamps to 60s, `999999` clamps to 3600s |
| **M-4 (DB)** | `products_ceramic_price_positive` (`> 0`) **and** `products_ceramic_price_present` (not-null) CHECKs, both `NOT VALID`→`VALIDATE`, guarded to `type = 'ceramic'` only. Live read confirmed **0** of 125 ceramic rows have a NULL/0 price before shipping the NOT-NULL half. | pgTAP: 0-priced + NULL-priced ceramic both rejected (`23514`); NULL-priced print accepted |
| **M-4 (app)** | New `src/lib/catalog/read-schemas.ts` (`parseProductRow`/`parseProductRows`) routes all five raw-row sites in `src/lib/catalog/repository.ts` through one shared ceramic-only-positive-price guard, replacing bare `as ProductSeedRow` casts. **Two-tier by audience** (Ruling below): storefront readers (`readCeramicProducts`, `readPrintDesigns`) skip+exclude a bad row; admin readers (`listCatalogRows`, `readProductRow`, `updateProductMeta`, `updateProductStatus`) validate+report (Sentry) but keep it. `mapCeramicProducts`'s `?? 0` fallback removed. Admin write schema tightened `.nonnegative()`→`.positive()`. | `src/lib/catalog/`: 55+ tests, all 5 reader paths + print-row pass-through covered |
| **L-12** | Three FK indexes: `product_media_variant_idx`, `products_drop_idx`, `prodigi_orders_order_idx` | idempotent `create index if not exists`, no test needed |
| **L-13** | `fulfilment_jobs_status_check` (8 values, from a full code enumeration across `src/server/fulfilment/`+`worker.ts`, cross-checked against live data: 2 live rows, both in the list; `in_production` deliberately excluded as confirmed-dead code) and `prodigi_status_stage_check` (5 values incl. code's own `'Unknown'` fallback, cross-checked against live data: 3 rows, both stages in the list). **`src/server/prodigi/merge.ts` now clamps any unrecognised upstream Prodigi stage to `'Unknown'` before persisting** (final-review fix — see below) so the CHECK and the code agree on vocabulary. | pgTAP: typo'd `'canceled'` rejected on both columns; `merge.test.ts` covers the clamp + Sentry alert + known-stage passthrough |

### Rulings (both driven by the tooling gap, both carried prominently into the migration's own comments — not buried)

1. **M-3 dynamic policy drop, not hardcoded names.** A wrong `DROP POLICY IF EXISTS "<guessed-name>"` is a silent no-op — worst possible failure mode, no error, false confidence. The `DO $$` block is the live enumeration and the drop in one statement; provably correct regardless of actual names, matches the acceptance criterion exactly, safe no-op on shadow/CI DBs.
2. **Catalog-read guard is two-tier, not the plan's literal uniform "skip".** Traced actual callers in `src/lib/admin/catalog-list.ts`: `listProducts()` falls back to the **entire** code-registry snapshot the moment the DB row count looks short (`dbRows.products.length >= registry.products.length`), and `getProductEditorState()` silently substitutes stale registry-seed data on a null row. A uniform skip would have hidden the whole admin product list over one bad row, and blinded the one screen built to fix it. Storefront readers skip (the actual M-4 fix); admin readers validate+report-but-keep.

### Adversarial review (this PR)

A dedicated task review ran after each of the two implementation dispatches (migration+pgTAP; catalog mapper), both **Approved** with zero unresolved Critical/Important findings. A separate **final whole-branch review** (looking at cross-commit composition, not just each diff in isolation) then found:
- **1 Critical** — the new price CHECKs broke two **pre-existing** pgTAP fixtures (`guarded_product_status.sql`, `print_fulfilment_assets.sql`) that inserted ceramic rows with no price — `db.yml` would have gone red on this PR. Fixed: both fixtures given a positive price.
- **1 Important** — `prodigi_status_stage_check` constrained a column `merge.ts` writes verbatim from Prodigi's API; an unrecognised future stage would have hit `23514`, which `reconcile-orders.ts` classifies as `db_error` and deliberately does **not** count as a poll — silently disarming the M-12 stalled-order alert on exactly the order that needed it. Fixed: `merge.ts` now clamps to the known vocabulary + `Sentry.captureMessage`s on an unrecognised value.

Both fixed and re-reviewed clean (scoped re-review, no new Critical/Important breakage). Full ledger with rulings, all task-review findings, and parked minors: session's SDD workspace (not committed — ephemeral per-plan working notes).

### Verification

- `npm run lint` ✅ · `npm run typecheck` ✅ (app + worker tsconfig)
- `npx vitest run src/lib/catalog/ src/server/prodigi/ src/server/fulfilment/`: all green
- Full `npm test`: 2035/2038 — 3 known pre-existing Windows-local failures (`orders-cli`/`prodigi-cli` env-loading), confirmed **untouched** by this branch's diff; CI is the oracle
- **Local `supabase test db` never ran** — Docker Desktop's backend process runs but its API socket never responds in this environment (reproduced independently, hung `docker.exe` client processes killed). All SQL was reviewed manually (byte-diffed RPC bodies against source, hand-traced pgTAP fixtures against every table's real constraints) but **CI's `db.yml` (path-filtered on `supabase/**`) is the first real execution** — watch it closely on this PR, do not treat a green PR merge as optional confirmation.

### Post-merge operator steps

1. Watch `db.yml` on this PR — it is the first time this SQL has ever executed anywhere.
2. Migration auto-applies ~1 min after merge, ~6 min before the Workers deploy — old code runs against the hardened DB in between (verified safe per-block in the migration's own header comment).
3. **Live read-only checks** (genuinely read-only, safe to run any time post-merge): `select has_function_privilege('anon','reserve_pieces(text[],uuid,integer)','execute');` → expect `f` (repeat for the other 3 RPCs); `select count(*) from pg_policies where tablename='piece_state';` → expect `0`; re-run advisors → expect 0006 gone.
4. **Stop signals:** checkout 5xx spike right after the migration applies (RPC/TTL-clamp regression — rollback = `CREATE OR REPLACE` back to the prior bodies, in the migration's own header comment); collection pages missing products (mapper too aggressive — check Sentry for `catalog row failed validation` skip-reports, which should be zero given the live price check found 0 bad rows); a Prodigi callback repeatedly failing for one order (check for an unrecognised stage — should now be impossible given the `merge.ts` clamp, but if seen, check the new `Sentry.captureMessage('prodigi order returned an unrecognised status stage', ...)`).
5. A live test-mode checkout (reserve→PI) is optional confirmation that `reserve_pieces` still works post-migration — not required before merge (state-changing, out of scope for this read-only verification pass; piggybacks Plan 05's rehearsal pattern if desired).

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
