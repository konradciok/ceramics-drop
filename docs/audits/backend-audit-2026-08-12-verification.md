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
| Plan 01 T5 pre-check | **C-1** (live `enabled_events`) | `GET /v1/webhook_endpoints` (livemode, MCP) | Single live endpoint `we_1TgXEgJ0KFK9lrjHNbgIUSbr` → `https://anna-ciok.studio/api/stripe/webhook`, `api_version 2026-05-27.dahlia` (matches SDK pin), `enabled_events` = `payment_intent.{succeeded,canceled,payment_failed,created,processing,requires_action}`, `charge.dispute.{closed,created}`, `charge.captured` — **`charge.refunded` and `refund.failed` both missing**, exactly as the audit found. | **ACTION** (Task 5 gate: add both events) |
| Plan 01 T5 pre-check | **C-1** (damage still standing) | `npm run orders -- order get 8be30881…` (prod Supabase, PII-redacted) + `GET /v1/refunds?payment_intent=pi_3Tw1WW…` (livemode, MCP) | Order `8be30881-4f02-44a6-9627-221f54c67125` still `status='paid'`; piece `s15` still `sold` (order_id matches); refund `pyr_1Tw3aZJ0KFK9lrjHTvwyQoly` **succeeded, full 13 900 gr (139 zł), BLIK**. Un-reconciled as of 2026-08-13 — backfill still required (Task 5 gate 2). | **ACTION** |
| §15.1 | Stripe **v2 Event Destinations** | `GET /v2/core/event_destinations` (test-mode key) + livemode inference | **Test mode:** 2 destinations — `ed_test_61Unzq…` (thin payload, only `v2.core.account_*` events) and the v2 mirror of legacy endpoint `we_1TebsmJ4XAbcEQUuEK9nt0RX` (snapshot, has `charge.refunded`, missing `refund.failed`). **No test-mode v2 destination independently re-adds `charge.refunded`.** **Live mode:** not directly listable read-only from this machine (no live key locally; the MCP connector exposes no v2 operations) — but the livemode v1 list shows exactly one endpoint (above), and the DB proof (a succeeded 2026-07-22 full refund left the order `paid`) rules out any *working* alternative `charge.refunded` delivery path to the storefront. Fix target stays "subscribe the event on `we_1TgXEg…`". Operator: glance at Dashboard → Event destinations during the gate as final confirmation. | **CLOSED** |
| Plan 01 T5 post-check tooling | Opp-2 | `npm run orders -- webhook-config-check` (test-mode key) | New drift guard ran against the test-mode account: correctly flagged `we_1Tebsm…` missing `refund.failed` (exit 4, `webhook_config_drift`). Post-gate confirmation against live requires a live key in the loaded env (`ADMIN_STRIPE_SECRET_KEY` or `STRIPE_SECRET_KEY`). | **CLOSED** (tooling verified) |

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
