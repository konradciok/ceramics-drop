# Remediation 10 — Global rate limiting via Workers binding (M-8 / M-9 / §6.1) — P2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §5 M-8/M-9, §6.1, §13 Opp-1. Evidence re-verified at HEAD `3da7ee0`.

**Goal:** Replace the per-isolate in-memory limiters — which provide **no global throttle** on Workers — with the native Workers rate-limit binding, closing the two concrete abuse vectors: unauthenticated arbitrary-recipient email sending (mail-bomb + Resend-reputation damage → order-confirmation deliverability, M-8) and full-catalogue reservation griefing that closes the shop every 15 minutes with no money moved (M-9).

**Architecture:** Add `ratelimit` bindings in `wrangler.jsonc` (one per route family with its window/limit), and a thin adapter that prefers the binding when present and falls back to the existing in-memory limiter locally (where bindings are absent in plain `next dev`). The route-level call-sites keep their current shape — the limiter factory grows a binding-aware variant, so route diffs are minimal.

**Tech stack:** Cloudflare Workers rate-limiting binding (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ — confirm current syntax + GA/beta status at implementation time), existing `checkout-rate-limit.ts` / `return-rate-limit.ts`.

## Objective

Every abuse-relevant unauthenticated endpoint gets a **cross-isolate** limit; the in-memory limiter remains only as the local-dev fallback and defense-in-depth.

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

`wrangler.jsonc` declares per-family `ratelimit` bindings; all six consumer routes throttle globally in production; local dev behaviour unchanged; the WAF checkout rule stays (defense-in-depth).

## Scope

- `wrangler.jsonc` (bindings), `cloudflare-env.d.ts` / `cloudflare-bindings.d.ts` (types; regen with `npm run cf-typegen` if applicable)
- `src/lib/checkout-rate-limit.ts` + `return-rate-limit.ts` (binding-aware variant), the six consumer routes (swap factory call only)
- Tests for the adapter

## Out of scope

- Removing the WAF rule (keep it).
- Turnstile / CAPTCHA (deferred, above).
- Per-user (authenticated) limits; admin routes (Access-gated already).
- Changing any limit *values* beyond mapping the current ones onto the binding's supported windows.

## Implementation steps

- [ ] **Docs check first:** confirm the current rate-limit binding config shape (`unsafe.bindings` vs stable `ratelimit` key), supported `period` values (binding supports a limited window set — historically {10, 60} seconds), and per-key `limit()` API. Map current limits: checkout 30/60 s, newsletter 5/60 s, confirm 20/60 s, interest 10/60 s, login+returns 3/600 s → **the 600 s window is likely unsupported**; if so, approximate returns/login as e.g. 1/60 s sustained (equivalent throughput, tighter burst) and record the mapping decision.
- [ ] Add bindings in `wrangler.jsonc` — one binding per family with a distinct `namespace_id`, e.g. `RL_CHECKOUT`, `RL_NEWSLETTER`, `RL_NEWSLETTER_CONFIRM`, `RL_INTEREST`, `RL_AUTH_RETURNS`.
- [ ] Extend the limiter factory: `createCheckoutRateLimiter({ binding?: RateLimit, …existing })` — when `binding` is provided, `allow(ip)` calls `binding.limit({ key: ip })` and returns its verdict; otherwise the existing Map path runs (local dev / tests). Keep the in-memory check as an additional fast-path guard in front of the binding call (defense-in-depth, saves binding ops on hot abuse).
- [ ] Failing tests first: adapter prefers the binding verdict when present (mock binding: deny → 429 even though the Map would allow); falls back to Map without a binding; binding errors fail **open** with a structured log (availability over strictness for checkout — document this choice; for newsletter/interest failing **closed** is acceptable and preferable — decide per-route and test both).
- [ ] Wire each of the six routes: fetch the binding from the route's env (`getCloudflareContext().env.RL_*` — these are fetch-path routes, ALS is fine here) and pass it to the singleton factory. Keep 429 response shapes identical.
- [ ] `npm run cf-typegen` (or manual d.ts) so the bindings typecheck.
- [ ] `npm run preview:cf` — bindings exist in wrangler preview: hammer one endpoint (`for i in $(seq 40); do curl -s -o /dev/null -w "%{http_code}\n" -X POST <preview>/api/newsletter …; done`) and observe global 429s after the limit.
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
- **Preview:** the hammer test above — paste the status-code sequence showing the flip to 429 at the threshold; confirm two different source paths (two terminals/IPs if feasible, else note single-IP scope) still share the global counter.
- **Live read-only:** post-deploy, normal traffic unaffected (Workers logs: no unexpected 429s in the first hour).
- **Live mutation:** none.

## Rollout / recovery

1. Single PR. Watch post-deploy 429 rates — legitimate users should essentially never hit these limits (values unchanged from today's intent).
2. **Rollback:** revert PR; in-memory behaviour returns.
3. **Stop signals:** any 429 on a legitimate checkout flow (session-storage attemptId retries could theoretically burst — the 30/min value has headroom, but watch it); binding runtime errors in logs above noise level.

## Acceptance criteria

- [ ] All six routes throttle via the binding in preview (hammer evidence pasted).
- [ ] Local dev + `npm test` run without bindings present.
- [ ] Checkout fails open on binding outage; newsletter/interest per the recorded per-route decision.
- [ ] No legitimate-traffic 429s in the first post-deploy day (operator check).

## Dependencies

None hard. Independent of all other plans.

## Risks / unresolved questions

- Binding window granularity (10/60 s) forces an approximation for the 10-min windows — the mapping decision is the one genuine design choice; record it in the PR.
- The binding is per-colo-ish in implementation (Cloudflare documents it as not perfectly global) — still categorically better than per-isolate; note the residual in the code comment so nobody oversells it.
- M-9's griefing path is bounded but not eliminated (30 checkouts/min/IP can still reserve pieces) — the WAF rule + binding together raise cost; full elimination would need Turnstile (deferred) or reservation-after-PI (rearchitecture, out of scope).
