# Remediation 09 — Admin & auth hardening (M-7 / M-6 / H-2 residual / M-1 / L-26 / L-27 / L-29 / L-30) — P2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §5 (auth group), §11. Evidence re-verified at HEAD `3da7ee0`. Consumes Plan 04's Task 2 (Access policy) and Task 5 (H-2 probes) outcomes.

**Goal:** Add the missing cross-site-request defenses on the admin surface, close the fail-open allowlist and the latent path-normalization fragility, tighten the guest-order backfill guard before any non-OAuth provider is enabled, and clean up the admin-clients hygiene items.

**Architecture:** The single admin choke point is the worker gate (`worker.ts:34-47` → `src/lib/admin/access.ts`) — implement the CSRF/Origin and path-normalization defenses **there** so all 16 admin routes are covered at once, rather than per-route preambles. Small point fixes elsewhere (`link-orders.ts`, `auth/login`, `clients.ts`, jose options).

**Tech stack:** Cloudflare Worker request handling, jose, existing access-gate unit tests (if any — check `src/lib/admin/access.test.ts`).

## Objective

- A forged cross-site request from a logged-in operator's browser can no longer trigger state-changing `/api/admin/*` actions (M-7 — today the edge injects the Access JWT and no Origin/content-type check exists).
- An unset `ADMIN_ALLOWED_EMAILS` no longer silently widens admin to "anyone passing the Access app policy" on production hostnames (M-6, fail-closed variant selected by Plan 04's findings).
- Percent-encoded/duplicate-slash path variants cannot outflank the gate even if Next/OpenNext dispatch behaviour ever changes (H-2 residual).
- A future phone/OTP provider cannot enable the guest-order sweep for unverified emails (M-1).
- Hygiene: pinned JWT algorithms (L-26), login Origin check (L-27), strict actor header under local bypass (L-29), truthful `clients.ts` docs + prod-misconfig guard (L-30).

## Findings covered

- **M-7** (MEDIUM `[INFERENCE]`) → PLANNED
- **M-6** (LOW; severity gated on Plan 04 Task 2) → PLANNED (fail-closed + startup warning)
- **H-2** (LOW `[REFUTED]`, residual hardening) → PLANNED (empirically re-confirmed by Plan 04 Task 5 first)
- **M-1** (LOW, latent) → PLANNED (one-line guard tighten + test)
- **L-26, L-27, L-29, L-30** (LOW) → PLANNED
- **L-16** (attemptId order-existence oracle, 122-bit entropy) → **DEFERRED** — infeasible to exploit per audit; no change worth the churn.
- **L-31** (`/api/returns` capability-token residuals) → **DEFERRED** — audit assesses the design as deliberate and well-hardened.

## Current-state evidence

All `VERIFIED` at HEAD `3da7ee0`:

- **M-7** — grep `sec-fetch` (ci) across `src/`, `worker.ts`, `public/` = 0 hits; grep `origin` under `src/app/api/admin` + `src/lib/admin` = 0 hits. Admin routes call `req.json()` directly (`create-shipment/route.ts:17`, `end-drop/route.ts:13`, `toggle-showroom/route.ts:16`, …). `route-helpers.ts` does body-parsing/uuid only, and only for 3 of 16 routes — the worker gate is the only universal choke point.
- **M-6** — `access.ts:78-85`: allowlist block entirely skipped when `ADMIN_ALLOWED_EMAILS` unset → `{ ok: true }` for any valid-AUD Access JWT. Config check above (:60-62) properly 404s without team domain/AUD.
- **H-2** — `access.ts:3,37-39`: `ADMIN_PATH_RE` on the raw `new URL(request.url).pathname` (from `worker.ts:34`); no decode/normalize.
- **M-1** — `link-orders.ts:31-34`: `if (!user.email_confirmed_at && !user.confirmed_at) return;` — proceeds when *either* is set; `confirmed_at` is also set by phone confirmation. Latent-only today (Google/Apple OAuth both set `email_confirmed_at`).
- **L-27** — `signout/route.ts:21-27` has the conditional Origin-equality check; `login/route.ts` has none (its `origin` var at :63 is the OAuth redirect base, not a check).
- **L-30** — `clients.ts:1-9` claims "Never committed/deployed (gitignored via .git/info/exclude)" — **false**: `git ls-files` shows it tracked; `.git/info/exclude` has only `.claude/*`. The `ADMIN_*` overrides (:35-46) are untyped (widened `AdminEnv`, :15-16) and could silently repoint prod admin at another Stripe/Supabase account.
- **L-26 / L-29** — jose verify without pinned `algorithms`; actor-email header fallback under `STUDIO_ADMIN_LOCAL_BYPASS` (exact lines: locate in `access.ts` / `worker.ts:41-47` during implementation).
- `NEEDS-RUNTIME-VERIFICATION` (Plan 04): Access app policy breadth (decides M-6 urgency); H-2 preview probes (expect 404s).

## Desired end state

State-changing admin requests require same-origin provenance; the gate normalizes paths before matching; allowlist absence fails closed on prod hostnames with a clear operator signal; the backfill guard requires a verified email specifically; docs/typing hygiene restored.

## Scope

- `worker.ts` (admin-gate section only), `src/lib/admin/access.ts`
- `src/lib/account/link-orders.ts`
- `src/app/api/auth/login/route.ts`
- `src/lib/admin/clients.ts` (comment + optional prod warn)
- jose verify options (customer session verify + Access JWT verify — both pin)
- Tests: access-gate tests, link-orders tests, login route test

## Out of scope

- Rate limiting (Plan 10). Admin UI changes. The Cloudflare Access **application policy** itself (dashboard — operator action from Plan 04 Task 2 if needed).
- Any change to the OAuth/PKCE flow or cookie handling (audited sound).

## Implementation steps

### Task 1 — M-7: same-origin enforcement at the worker gate

- [ ] Failing tests first (access-gate test file; create `src/lib/admin/access.test.ts` if absent): for a state-changing method (POST/PUT/PATCH/DELETE) to an admin path — (a) `Origin` present and ≠ self → 403; (b) `Origin` absent AND `Sec-Fetch-Site` present and ∉ {`same-origin`,`none`} → 403; (c) same-origin POST passes; (d) GETs unaffected.
- [ ] Implement in the gate path (new pure helper in `access.ts`, e.g. `verifyAdminRequestProvenance(request): { ok } | { ok: false; status: 403 }`), called from `worker.ts` alongside `verifyAdminAccess`. Logic: for non-GET/HEAD, require (`Origin` === request origin) when Origin is present; else require `Sec-Fetch-Site` ∈ {`same-origin`, `none`} when present; if **neither** header is present, reject (modern browsers always send one; non-browser callers — the CLI uses direct service credentials, not this surface).
- [ ] Confirm the admin UI's own fetches pass (they are same-origin by construction; verify one mutation from the local admin UI under `STUDIO_ADMIN_LOCAL_BYPASS`).
- [ ] Green + commit: `feat(admin): same-origin provenance check for state-changing admin requests (M-7)`

### Task 2 — H-2 residual + M-6: gate normalization & fail-closed allowlist

- [ ] Pre-check: Plan 04 Task 5 probes returned 404s (recorded). If they didn't — stop, this task escalates per that plan.
- [ ] Failing tests: `isAdminPath('/api/%61dmin/refund')` → true; `'/api/admin%2Frefund'` → true; `'//api//admin/x'` → true; `'/API/ADMIN/x'` → true; malformed percent-encoding (decode throws) → treated as admin (fail-closed).
- [ ] Implement normalization in `isAdminPath`: try/catch `decodeURIComponent`, collapse repeated slashes, lowercase, then regex-test **both** raw and normalized forms (match on either).
- [ ] M-6 (variant per Plan 04 Task 2 outcome — both variants below keep the code change identical; the outcome decides urgency/comms only): in `access.ts:78-85`, when `ADMIN_ALLOWED_EMAILS` is unset/empty **and** the request host is the production hostname, return `{ ok: false, status: 403 }` and log a structured `admin_allowlist_missing` error (+ `Sentry.captureMessage` once available in worker context — Plan 03).
- [ ] **Ordering (critical): evaluate the production-host missing-allowlist deny BEFORE honouring `STUDIO_ADMIN_LOCAL_BYPASS`.** If the bypass is checked first, a bypass flag mistakenly set on a production deployment would skip the 403 and preserve the exact M-6 fail-open the task closes. The precedence must be: production host + empty `ADMIN_ALLOWED_EMAILS` → **403**, regardless of the bypass flag; the local bypass is honoured **only** on a non-production hostname (or gated behind an explicit non-prod assertion). Non-prod/dev keep current behaviour so preview doesn't break.
- [ ] Failing test for the ordering: production host + `STUDIO_ADMIN_LOCAL_BYPASS` set + missing `ADMIN_ALLOWED_EMAILS` → **403** (proves bypass cannot re-open the fail-open on prod).
- [ ] **Coordination step (required before merge):** confirm via Plan 04 Task 2 that `ADMIN_ALLOWED_EMAILS` IS set in prod — otherwise merging this locks the operator out of `/admin` until the secret is set (which is the intended fail-closed, but must be sequenced: set secret first [gated], then merge).
- [ ] Green + commit: `fix(admin): normalize gate path matching; fail closed without ADMIN_ALLOWED_EMAILS on prod (H-2, M-6)`

### Task 3 — M-1 + L-26 + L-27: auth point fixes

- [ ] `link-orders.ts:34` → `if (!user.email_confirmed_at) return;` (drop the `confirmed_at` alternative). Update the comment (phone confirmation must never enable the sweep). Failing test: a user with `confirmed_at` set but `email_confirmed_at` null links nothing.
- [ ] Pin jose algorithms to the **set of currently-active** signing algorithms, not a single one — a single-alg pin rejects valid tokens signed by another active key during a rotation window. Read each JWKS during implementation and pass **every** active alg it serves: **Supabase** commonly carries both ES256 (new signing keys) and RS256 (legacy) simultaneously mid-rotation → pass `algorithms: ['ES256', 'RS256']` when both appear in the JWKS (derive the list from the JWKS `kty`/`alg`, don't hardcode blindly); **CF Access** → `algorithms: ['RS256']`. The goal is to reject *unexpected* algorithms (e.g. `HS256`, `none`) while accepting every algorithm the project's own JWKS actively uses. Tests: a valid token for **each** active algorithm verifies; a token with an unsupported alg is rejected.
- [ ] `login/route.ts`: add the same conditional Origin-equality check as `signout/route.ts:21-27` (copy the pattern verbatim, incl. comment). Test mirrors signout's.
- [ ] Green + commit: `fix(auth): verified-email-only order backfill, pinned JWT algs, login Origin check (M-1, L-26, L-27)`

### Task 4 — L-29 + L-30: admin hygiene

- [ ] L-29: under `STUDIO_ADMIN_LOCAL_BYPASS`, ensure the actor email recorded in audit logs is a fixed sentinel (e.g. `local-bypass@localhost`) rather than any client-supplied header value; the worker already strips/rewrites `X-Admin-Actor-Email` (`worker.ts:41-47` region) — extend the strip to the bypass branch. Test if the seam allows.
- [ ] L-30: rewrite the `clients.ts:1-9` header comment to the truth (tracked file; `ADMIN_*` overrides are a local-dev convenience). Add a runtime guard that **fails closed on production**: if any `ADMIN_*` override is set while the request host is the production hostname, **reject** the admin request (throw / return an error) with a structured `admin_env_override_in_prod` log — a warning-only guard does not prevent a mutation being executed against the *wrong* Stripe/Supabase account, which is the actual L-30 risk (a mis-set override silently repoints prod admin at another account). If a genuine emergency override is ever needed on prod, it must go through a **separately-gated emergency flag** that also asserts the intended target account (name/ref) matches — not the ambient `ADMIN_*` vars. Keep **warning-only** behaviour for non-production hosts (dev/preview convenience). Document the three vars in `.env.example`'s optional block (coordinates with Plan 08 — whichever lands second reconciles).
- [ ] Failing test: `ADMIN_*` override set + production host → request rejected; same override + non-prod host → allowed with a warning log.
- [ ] Green + commit: `fix(admin): truthful clients docs, strict bypass actor, prod-override warning (L-29, L-30)`

## Database / migration work

None.

## External-system changes

- Sequencing gate only: `ADMIN_ALLOWED_EMAILS` must be confirmed set in prod (Plan 04 Task 2) **before** Task 2 merges; if unset, setting it is a gated live mutation done first.
- If Plan 04 found the Access app policy broad: tightening it is a dashboard change (operator, gated) — independent of this code.

## Tests

- **New:** provenance-check matrix (Origin/Sec-Fetch-Site/method combinations); path-normalization matrix incl. malformed-encoding fail-closed; allowlist fail-closed on prod host + unchanged non-prod; link-orders verified-email guard; login Origin check.
- **Regressions caught:** re-widening of the gate regex; allowlist reverting to fail-open; backfill guard loosening.
- **Simulated:** forged cross-site admin POST; encoded-path probe; phone-confirmed-only user.

## Verification

- **Local/unit:** `npm run lint && npm run typecheck && npm test` — paste. Manual: one admin mutation from the local admin UI still works under bypass; a `curl -X POST -H "Origin: https://evil.example"` against local admin API → 403.
- **Preview:** repeat Plan 04's H-2 probes post-change (still 404 from Next, and now also 403/404 from the gate for matched-after-normalization variants); a cross-origin POST probe → 403.
- **Live read-only:** after deploy, load an `/admin` **read** page (e.g. the orders list) as the operator to confirm no gate lockout; Workers logs show no `admin_allowlist_missing`.
- **Live mutation (gated, operator-performed):** performing an actual admin **action** (refund / shipment / status change) is state-changing, not a read-only check — it requires operator approval and should target a safe/test order. Prefer confirming the provenance + gate behaviour via the preview curl probes above rather than a real production mutation. Plus the possible pre-sequenced `ADMIN_ALLOWED_EMAILS` secret set (gated above).

## Rollout / recovery

1. Tasks are independently mergeable; Task 2 has the sequencing gate.
2. **Rollback:** PR revert; no state.
3. **Stop signals:** operator locked out of `/admin` (403 loop) → check `ADMIN_ALLOWED_EMAILS` value/casing first, revert second; legitimate admin UI mutations failing the provenance check (would indicate a proxy stripping Origin — loosen to log-only mode while investigating).

## Acceptance criteria

- [ ] Cross-origin admin POST → 403 (unit + preview curl evidence).
- [ ] Encoded/duplicate-slash admin paths match the gate (unit matrix green).
- [ ] Unset allowlist on prod host → 403 + structured log (unit).
- [ ] Phone-only-confirmed user triggers no backfill (unit).
- [ ] jose verifies pin `algorithms`; login has the Origin check.
- [ ] `clients.ts` comment truthful; prod-override warning in place.
- [ ] Operator confirms normal admin access post-deploy.

## Dependencies

- **Plan 04** Tasks 2 & 5 (inputs to Task 2 here). Plan 03 (worker Sentry) for the gate's captureMessage calls — degrade to console logging if not yet landed. Plan 08 coordinates the `.env.example` `ADMIN_*` block.

## Risks / unresolved questions

- Provenance check vs non-browser tooling: anything legitimately POSTing to `/api/admin/*` without browser headers (none known — CLI goes direct to Stripe/Supabase) would break; grep the repo + ask the operator about external callers before merging Task 1.
- Cloudflare Access's own cookie-refresh redirects should be unaffected (GETs), but verify one full Access login → admin mutation cycle in prod after deploy.
