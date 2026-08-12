# Remediation 10 — Global rate limiting via Workers binding (M-8 / M-9 / §6.1) — P2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §5 M-8/M-9, §6.1, §13 Opp-1. Evidence re-verified at HEAD `3da7ee0`.

**Goal:** Replace the per-isolate in-memory limiters — which provide **no cross-isolate throttle** on Workers — with the native Workers rate-limit binding, closing the two concrete abuse vectors: unauthenticated arbitrary-recipient email sending (mail-bomb + Resend-reputation damage → order-confirmation deliverability, M-8) and full-catalogue reservation griefing that closes the shop every 15 minutes with no money moved (M-9). **Note the binding is not a *globally exact* limiter** — see the contract below; it is a large, correct improvement over per-isolate, not a strict global counter.

**Architecture:** Declare the bindings under the top-level **`ratelimits`** key in `wrangler.jsonc`, each with `name`, a unique `namespace_id`, and `simple: { limit, period }` where **`period` is restricted to 10 or 60 seconds**. A thin adapter prefers the binding when present and falls back to the existing in-memory limiter locally (where bindings are absent in plain `next dev`). The route-level call-sites keep their current shape — the limiter factory grows a binding-aware variant, so route diffs are minimal.

**Binding contract & locality (load-bearing — do not describe this as a global counter):** `limit({ key })` is **eventually consistent** and enforced **per Cloudflare location** (data center), cached per-isolate and reconciled asynchronously against a location-local store — Cloudflare documents it as permissive, "not an accounting/auditing system." So: (a) counters are per-location, not one global tally; (b) the adapter keys by client IP, so different IPs use different counters (expected); (c) enforcement is cross-isolate **within a location**, which is the actual win over today's per-isolate Map. Objective and acceptance below are written to this reality, not to a global-exactness claim.

**Tech stack:** Cloudflare Workers rate-limiting binding (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ — confirm current syntax + GA/beta status at implementation time; the `ratelimits` + `simple{limit,period}` shape and the 10/60 s period restriction are current as of this writing), existing `checkout-rate-limit.ts` / `return-rate-limit.ts`.

## Objective

Every abuse-relevant unauthenticated endpoint gets a **cross-isolate, per-location** limit (eventually consistent — not a globally exact counter); the in-memory limiter remains only as the local-dev fallback and defense-in-depth.

## Findings covered

- **M-8** (MEDIUM) — newsletter/interest are unauthenticated arbitrary-recipient email senders guarded only per-isolate. → PLANNED
- **M-9** (MEDIUM) — `reserve_pieces` runs before the PI; per-isolate limits allow catalogue-wide reservation griefing (the single WAF rule covers only `POST /api/checkout`). → PLANNED
- **§6.1** (incomplete feature: global rate limiting) → PLANNED (close-out)
- Turnstile (audit's alternative) → **DEFERRED** — a product/UX decision (adds friction); the binding achieves enforcement without UX change. Revisit if binding limits prove insufficient against distributed abuse.
- **L-1** (validateCart per-item DB reads up to ~1028 before size guards) → **DEFERRED** — DB-amplification hygiene; partially mitigated by this plan's checkout limit; cheap reorder of guards can ride any future checkout change.

## Current-state evidence

All `VERIFIED` at HEAD `3da7ee0`:

- `src/lib/checkout-rate-limit.ts:14-21,33` — in-memory `Map` store, comment explicitly admits per-isolate scope ("best-effort backstop … the stronger global control is still the Cloudflare WAF rate-limit rule tracked in plan T15"). Defaults 30 req/60 s.
- Consumers (module-scope singletons): `checkout/route.ts:16,34,43` (30/min), `newsletter/route.ts:12,30,37` (5/min), `newsletter/confirm/route.ts:15,32,38` (20/min), `interest/route.ts:17,28,35` (10/min).
- `src/lib/return-rate-limit.ts` — second in-memory limiter (3/10 min); consumers: `returns/route.ts:7,12,40` and `src/lib/auth/rate-limit.ts:14-15` → `auth/login/route.ts:33`.
- No KV/DO/`ratelimit` binding anywhere in `wrangler.jsonc` or code.
- `CONFIRMED-LIVE` (audit): exactly one WAF rate-limit rule exists (Free plan cap), covering `POST /api/checkout` only.

## Desired end state

`wrangler.jsonc` declares per-family `ratelimits` bindings (`name` + `namespace_id` + `simple{limit,period}`, period ∈ {10,60}s); all six consumer routes throttle cross-isolate per-location in production (eventually consistent); local dev behaviour unchanged; the WAF checkout rule stays (defense-in-depth).

## Scope

- `wrangler.jsonc` (bindings), `cloudflare-env.d.ts` / `cloudflare-bindings.d.ts` (types; regen with `npm run cf-typegen` if applicable)
- `src/lib/checkout-rate-limit.ts` + `return-rate-limit.ts` (binding-aware variant)
- **`src/lib/auth/rate-limit.ts`** — the login limiter wrapper (`createAuthRateLimiter`) delegates to `createReturnRateLimiter`; it must be updated to thread the binding through, or `auth/login` silently stays on the per-isolate Map fallback while the other routes use the binding. Do **not** omit this file.
- the six consumer routes (swap factory call only): checkout, newsletter, newsletter/confirm, interest, returns, **auth/login**
- Tests for the adapter **and** a login integration test proving `auth/login` uses the binding-backed limiter

## Out of scope

- Removing the WAF rule (keep it).
- Turnstile / CAPTCHA (deferred, above).
- Per-user (authenticated) limits; admin routes (Access-gated already).
- Changing any limit *values* beyond mapping the current ones onto the binding's supported windows.

## Implementation steps

- [ ] **Docs check + verify current budgets first:** confirm the binding config shape (`unsafe.bindings` vs stable `ratelimit` key), supported `period` values (binding supports a limited window set — historically **only {10, 60} seconds**), and the per-key `limit()` API. Read each route's **actual** current budget from code (do not assume): checkout 30/60 s, newsletter 5/60 s, confirm 20/60 s, interest 10/60 s, **returns** (`return-rate-limit.ts` defaults 3/600 s), **login** (`src/lib/auth/rate-limit.ts` — confirm its exact value; it is **not** the same as returns, verify whether it is 10/600 s). Record the verified numbers in the plan/PR.
- [ ] **Do not loosen budgets in the mapping.** The 600 s window is unsupported by the binding, but approximating 3/600 s as `1/60 s` is **wrong** — `1/60 s` permits 10 requests per 600 s vs the intended 3, i.e. ~3× looser. For any route whose window the binding can't express (returns, login), choose one of: (a) keep it on the existing in-memory limiter (+ WAF) and document why the binding doesn't fit, or (b) if approximating, pick a bound **no looser** than the original (e.g. a lower per-60 s cap or the binding's smallest window) and state the exact effective budget. Never silently increase the allowance.
- [ ] Add bindings in `wrangler.jsonc` — one binding per family with a distinct `namespace_id`, and **separate bindings for login and returns** (their budgets and semantics differ; do not share one `RL_AUTH_RETURNS`): `RL_CHECKOUT`, `RL_NEWSLETTER`, `RL_NEWSLETTER_CONFIRM`, `RL_INTEREST`, `RL_RETURNS`, `RL_LOGIN`.
- [ ] Extend the limiter factory: `createCheckoutRateLimiter({ binding?: RateLimit, onOutage?: 'open' | 'closed', …existing })` — when `binding` is provided, `allow(ip)` calls `binding.limit({ key: ip })` and returns its verdict; otherwise the existing Map path runs (local dev / tests). Keep the in-memory check as an additional fast-path guard in front of the binding call (defense-in-depth, saves binding ops on hot abuse). **The outage policy is an explicit input per call site — the shared adapter must not infer it.**
- [ ] **Binding-outage policy table (define for ALL six routes, not just checkout):**

  | Route | On binding error | Rationale |
  |---|---|---|
  | checkout | **fail-open** | availability of the money path outweighs a brief limiter gap; WAF rule still covers it |
  | newsletter | **fail-closed** | unauthenticated arbitrary-recipient email sender (M-8) — a gap is a mail-bomb window |
  | newsletter/confirm | **fail-closed** | same email-abuse surface |
  | interest | **fail-closed** | same (unauthenticated sender) |
  | returns | **fail-closed** | creates real return shipments; abuse has cost |
  | auth/login | **fail-closed** | credential endpoint; a limiter gap aids brute-force |

  (Adjust only with a recorded rationale; the point is every route has an explicit, tested policy — no route left to adapter inference.)
- [ ] Failing tests first: adapter prefers the binding verdict when present (mock binding: deny → 429 even though the Map would allow); falls back to Map without a binding; **binding error → the per-route policy from the table above** (checkout allows-with-log; the other five 429/deny-with-log) — one test per route.
- [ ] Wire each of the six routes: fetch the binding from the route's env (`getCloudflareContext().env.RL_*` — these are fetch-path routes, ALS is fine here) and pass it **plus its `onOutage` policy** to the singleton factory. For `auth/login`, thread the binding through `src/lib/auth/rate-limit.ts`'s wrapper. Keep 429 response shapes identical.
- [ ] `npm run cf-typegen` (or manual d.ts) so the bindings typecheck.
- [ ] `npm run preview:cf` — bindings exist in wrangler preview: hammer one endpoint from a **single IP/key** (`for i in $(seq 40); do curl -s -o /dev/null -w "%{http_code}\n" -X POST <preview>/api/newsletter …; done`) and observe 429s after the limit. Because the counter is per-location + eventually consistent, assert **same-key** enforcement across isolates (the same IP hitting the limit), not a globally exact cutoff — the flip to 429 may be slightly permissive by design.
- [ ] Commit: `feat(rate-limit): global Workers rate-limit bindings with in-memory fallback (M-8, M-9)`

## Database / migration work

None.

## External-system changes

- The bindings deploy with `wrangler.jsonc` on the normal push-to-main flow — no dashboard mutation. (If the binding requires an account-level feature toggle/beta enrollment, that is a gated dashboard step — check during the docs step.)
- WAF rule untouched.

## Tests

- **New:** adapter tests (binding-preferred, fallback, error posture per route family); route-level test for one representative route asserting 429 from a denying binding.
- **Regressions caught:** silently dropping the binding (fallback masking); error-posture inversion (checkout failing closed on binding outage).
- **Simulated:** binding deny; binding throw; absent binding.

## Verification

- **Local/unit:** `npm test` green (paste adapter suite run).
- **Preview:** the hammer test above — paste the status-code sequence showing the flip to 429 at (approximately) the threshold; confirm the **same key/IP** is throttled across isolates within a location (the cross-isolate win). Do not expect a globally exact cutoff — the binding is eventually consistent and per-location; note this in the evidence.
- **Live read-only:** post-deploy, normal traffic unaffected (Workers logs: no unexpected 429s in the first hour).
- **Live mutation:** none.

## Rollout / recovery

1. Single PR. Watch post-deploy 429 rates — legitimate users should essentially never hit these limits (values unchanged from today's intent).
2. **Rollback:** revert PR; in-memory behaviour returns.
3. **Stop signals:** any 429 on a legitimate checkout flow (session-storage attemptId retries could theoretically burst — the 30/min value has headroom, but watch it); binding runtime errors in logs above noise level.

## Acceptance criteria

- [ ] All six routes throttle via the binding in preview, same-key/cross-isolate within a location (hammer evidence pasted; per-location eventual-consistency noted, not a global-exact claim).
- [ ] Bindings declared under top-level `ratelimits` with `name` + `namespace_id` + `simple{limit,period}`, `period` ∈ {10,60}s; separate `RL_LOGIN` / `RL_RETURNS`.
- [ ] Local dev + `npm test` run without bindings present.
- [ ] Every route has an explicit, tested binding-outage policy (checkout fail-open; newsletter/confirm/interest/returns/login fail-closed) per the policy table.
- [ ] No legitimate-traffic 429s in the first post-deploy day (operator check).

## Dependencies

None hard. Independent of all other plans.

## Risks / unresolved questions

- Binding window granularity (10/60 s) forces an approximation for the 10-min windows — the mapping decision is the one genuine design choice; record it in the PR.
- The binding is per-colo-ish in implementation (Cloudflare documents it as not perfectly global) — still categorically better than per-isolate; note the residual in the code comment so nobody oversells it.
- M-9's griefing path is bounded but not eliminated (30 checkouts/min/IP can still reserve pieces) — the WAF rule + binding together raise cost; full elimination would need Turnstile (deferred) or reservation-after-PI (rearchitecture, out of scope).
