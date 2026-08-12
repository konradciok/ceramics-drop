# Backend Audit 2026-08-12 — Verification Log

Live read-only evidence settling the `[UNVERIFIED]`/`[INFERENCE]`/§15 gaps from `backend-audit-2026-08-12.md`. This is the deliverable of **Plan 04** (`docs/superpowers/plans/2026-08-12-remediation-04-live-config-verification.md`); it is appended to as gates are checked. **No system was mutated** to produce any entry here — all checks are read-only API/CLI reads.

Legend: **CLOSED** = settled, no action · **ACTION** = settled, feeds a downstream plan · **OPEN** = not yet checked.

---

## Cloudflare-side gates — verified 2026-08-12

Access confirmed via `wrangler` OAuth (konrad.ciok@gmail.com, account `3ebc59b80b15b6b4850ae0734a24ce26`) and the Cloudflare API MCP (separate OAuth). Wrangler token covers workers/secrets/tail/queues/d1/zone-read + R2 reads; it does **not** carry an `access` scope, so the Zero Trust Access policy was read via the Cloudflare API MCP.

| Gate | Finding / §15 | Check | Result | Status |
|---|---|---|---|---|
| Plan 04 T2 | **M-6** (admin allowlist fail-open) | `wrangler secret list` + Access API `GET /accounts/{acct}/access/apps` + `.../policies` | Access app `anna-ciok.studio` (id `f78f44a5…`) covers `anna-ciok.studio/admin` **and** `/api/admin`; single **allow** policy `include` = exactly `ania@ciok.art`, `konrad@ciok.art` (no exclude/require). `ADMIN_ALLOWED_EMAILS` is **NOT set** in prod. | **ACTION** |
| Plan 04 T4 | **L-25** (R2 public-access posture) | `wrangler r2 bucket dev-url get` + `... domain list anna-ciok-print-assets` | `r2.dev` public access **disabled**; **no** custom domains attached → the HMAC signed-URL model is not bypassed. | **CLOSED** |
| Plan 04 T6 | **§15.9** (prod secret presence) | `wrangler secret list` (names only) | 36 secrets. All runtime-required names present **except `ADMIN_ALLOWED_EMAILS`** (see M-6). `FULFILMENT_DEBUG_TOKEN`, `ADMIN_SUPABASE_URL`, `ADMIN_STRIPE_SECRET_KEY` correctly **absent**. | **ACTION** |
| Plan 03 T3 | §15.9 (worker-alert prereqs) | `wrangler secret list` | `SENTRY_DSN`, `RESEND_API_KEY`, `STUDIO_NOTIFY_EMAIL` all **present** → the new worker-context alerts (Plan 03) and the DLQ email have somewhere to go. | **CLOSED** |

### M-6 adjudication (severity + downstream action)
**Stays LOW**, exactly as the audit assessed. The code-level allowlist is fail-open (`ADMIN_ALLOWED_EMAILS` unset), **but** the Cloudflare Access **perimeter policy is narrow** — only the two named studio emails can reach `/admin`|`/api/admin` at all; everyone else is rejected at the edge before the request hits the worker. The fail-open allowlist is therefore defense-in-depth behind a narrow perimeter, not an open door.

**Downstream action (Plan 09):** when landing the fail-closed allowlist change, set `ADMIN_ALLOWED_EMAILS="ania@ciok.art,konrad@ciok.art"` **in the same rollout** (before/with the code) so the two layers agree and the operator is not locked out. Sequencing gate — do not merge the fail-closed change without the secret set.

**Observation (not part of M-6):** the `anna-ciok.studio` Access policy has no `require` (no login-method/MFA requirement), whereas the sibling `casalimon-api-admin` app requires a specific `login_method`. Worth considering adding MFA to the admin policy — tracked here as an optional hardening idea, not an audit finding.

---

## Remaining gates — not yet checked (non-Cloudflare)

| Gate | Finding / §15 | Where it's checked | Status |
|---|---|---|---|
| Plan 04 T1 | **H-4** (admin-editor `supabaseUrl is required.`) | Sentry — read the issue's newest event host + release/env + timing | OPEN |
| Plan 04 T3 | **M-25** (Supabase key format) | Supabase dashboard — legacy JWT vs `sb_secret_`/`sb_publishable_` | OPEN |
| Plan 04 T5 | **H-2** (admin-gate encoded-path probes) | `curl` against a **preview** deploy (never prod) | OPEN |
| Plan 04 T7 | **L-40** (ceramic EUR/GBP display-vs-charge parity) | read-only SQL vs `PRICE_EUR`/`PRICE_GBP` constants | OPEN |
| §15.1 | Stripe **v2 Event Destinations** | Stripe Dashboard / `GET /v2/core/event_destinations` (folded into Plan 01 T5) | OPEN |

---

*Prepared read-only. Entries are added as their owning plan (04/09/01/…) reaches the corresponding gate.*
