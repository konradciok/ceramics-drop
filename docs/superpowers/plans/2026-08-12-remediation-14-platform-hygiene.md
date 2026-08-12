# Remediation 14 — Platform hygiene: API headers, feed caching, cache scaffolding, retention (L-33 / L-32 / M-24 / L-14) — P2/P3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §5 M-24, L-14, L-32, L-33; §13 items 11/13/14. Evidence re-verified at HEAD `3da7ee0`. A batch of small, loosely-coupled platform items — each task is independently shippable; do not let one blocked task hold the others.

**Goal:** Give `/api` + `/admin` responses the security headers they currently lack, stop rebuilding the merchant feeds on every anonymous GET, resolve the inert OpenNext incremental-cache layer (noise + wasted reads), and bound the unbounded PII-bearing ledger/audit tables with a retention sweep.

**Architecture:** Headers land in `worker.ts`'s fetch wrapper (the only place that sees every response, including `/api` and `/admin`, which the middleware matcher excludes). Feed caching uses plain `Cache-Control: s-maxage` (CDN-level) because the app-level `unstable_cache` layer is exactly the thing M-24 shows to be inert. The cache-layer decision is resolve-don't-expand: configure the documented R2-based incremental cache **or** remove the scaffolding — decided by a time-boxed spike. Retention rides the existing 15-min cron.

**Tech stack:** `worker.ts` fetch wrapper, OpenNext caching docs (https://opennext.js.org/cloudflare/caching), existing cron sweeps.

## Objective

Close four platform-hygiene defects that individually are LOW/MEDIUM but collectively are operational drag: missing API security headers (CSP stays report-only — its enforce cutover is a separately-tracked deploy op, untouched here), per-request feed rebuilds, error-log noise + no-op cache writes at 100% sampling, and unbounded `webhook_events`/audit-log growth holding raw webhook PII forever.

## Findings covered

- **L-33** (LOW) — no security headers on `/api`/`/admin`; middleware matcher excludes them; `public/_headers` is a Pages convention not applied on this Workers deploy. → PLANNED (headers half). CSP **enforce** cutover → explicitly out of scope (existing pending op).
- **L-32** (LOW) — feeds rebuild the full catalogue per anonymous GET (`no-store`). → PLANNED
- **M-24** (MEDIUM) — inert incremental-cache layer: `set()` no-ops with error logs, reads always miss to Supabase, `revalidateTag` no-ops. → PLANNED (resolve via spike: adopt-or-remove)
- **L-14** (LOW) — `webhook_events` unbounded + PII in `raw_json`; same class: `cms_audit_log`, `catalog_audit_log`. → PLANNED (retention cron, Opp-11)

## Current-state evidence

All `VERIFIED` at HEAD `3da7ee0`:

- **L-33** — `src/middleware.ts:62-83` defines `SECURITY_HEADERS` (+ report-only CSP) but the matcher (:160-164) excludes `api|admin|_next|…`; `worker.ts:29-49` sets no headers; `public/_headers` (:10-15) carries HSTS/XCTO/etc. but on a Workers/OpenNext deploy it is a static asset, not applied — so `/api/*` and `/admin/*` responses ship with no security headers at all.
- **L-32** — `src/app/api/feed/google/route.ts` + `meta/route.ts` (byte-identical shells): `export const dynamic = 'force-dynamic'` (:5), `Cache-Control: no-store` (:19-24), full `getSoldIds()` + `getShowroomIds()` + `buildFeedItemsCms(...)` per request (:15-16).
- **M-24** — audit §5: OpenNext incremental cache is read-only static-assets mode while the app uses `unstable_cache` + `revalidateTag` → every `set()` errors into logs at 100% sampling, every read misses. (Re-verify the exact `open-next.config.ts` cache config lines at implementation.)
- **L-14** — `webhook_events` (`20260626120003` + `20260728120000`) has no retention/pruning anywhere (grep `delete from webhook_events` = expected 0); rows carry full `raw_json` (customer PII in Stripe events). Same for `cms_audit_log`/`catalog_audit_log`. The cron (`worker.ts`, `*/15`) already hosts idempotent sweeps to extend.

## Desired end state

Every `/api`/`/admin` response carries the baseline security-header set; feeds serve from CDN cache for a bounded window; the cache layer either works (R2-backed, reads hit) or is explicitly removed (no scaffolding, no noise) — no third state; ledger/audit rows older than the retention window are pruned on cron.

## Scope

- `worker.ts` (fetch wrapper: headers; cron: retention sweep)
- `src/app/api/feed/google/route.ts`, `src/app/api/feed/meta/route.ts`
- `open-next.config.ts` (+ possibly `wrangler.jsonc` R2 binding) — per the spike decision
- New sweep unit + tests

## Out of scope

- CSP enforce cutover (pending deploy-time op, tracked outside this plan).
- Middleware/HTML-page header changes (already correct for pages).
- Any feed content change; any cache adoption for non-feed routes beyond what the M-24 decision implies.
- Retention for `orders`/`order_items` (business records — never pruned).

## Implementation steps

### Task 1 — L-33: headers at the worker layer

- [ ] In `worker.ts`'s fetch path, after `handler.fetch` resolves, apply the baseline header set to responses whose path starts with `/api/` or `/admin` (mirror the names/values from `src/middleware.ts:62-83`, **minus** CSP/report-only — API responses need `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, `Permissions-Policy`; JSON doesn't take a CSP meaningfully and the CSP cutover is out of scope). Extract the shared name/value list into a small module both `middleware.ts` and `worker.ts` import (single source of truth).
- [ ] Unit-test the extracted list module; verify header presence in preview with `curl -sI <preview>/api/inventory`.
- [ ] Confirm no header conflicts with webhook responses (Stripe/InPost/Prodigi endpoints — headers are response-side, harmless, but check content-length/streaming interactions in preview).
- [ ] Commit: `feat(worker): security headers on /api and /admin responses (L-33)`

### Task 2 — L-32: CDN-cache the feeds

- [ ] Change both feed routes' response headers to `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400` (keep `force-dynamic` — the caching is CDN-side, deliberately NOT the inert app-layer cache; comment this rationale referencing M-24). One-hour staleness on merchant feeds is safe: Google/Meta fetch on multi-hour cadences; sold-out races are already tolerated by the feeds' design (state the assumption in the comment).
- [ ] Test: route test asserts the header; preview: two `curl -sI` calls and read `cf-cache-status`. **`s-maxage` is only a *hint* — if `cf-cache-status` is `DYNAMIC`, the feed still rebuilds on every request and the performance goal is NOT met.** Header-only readiness does **not** close L-32.
- [ ] **Acceptance for L-32:** a confirmed cache **HIT** on the second request (the feed served from CDN, not rebuilt). If the zone won't cache the Workers response without a cache rule, L-32 stays **OPEN** with a **gated zone-cache-rule follow-up** (dashboard change, operator) — do not mark L-32 done on the header change alone, and do not build a Cache API workaround in this plan.
- [ ] Commit: `perf(feeds): CDN cache headers on merchant feeds (L-32; HIT-gated)`

### Task 3 — M-24: resolve the cache layer (time-boxed spike → decide)

- [ ] Spike (≤ half a day): read `open-next.config.ts` + the OpenNext caching docs; determine what the *supported* R2 incremental-cache configuration requires (R2 binding + `incrementalCache` adapter + tag cache/queue choices) and whether the app's `unstable_cache`/`revalidateTag` usage would then actually function on Workers.
- [ ] Decision fork (record the choice + rationale in the PR):
  - **Adopt:** if the supported config is a bounded change (config + one R2 bucket/binding — bucket creation is a **gated** external mutation), wire it; verify in preview that a cached read hits (log/latency evidence) and `revalidateTag('inventory')` invalidates.
  - **Remove:** if adoption drags in queues/DO tag caches or destabilizes the build, strip the inert scaffolding instead: remove the `unstable_cache`/`revalidateTag` calls' dead cache expectations (keep the functions working uncached), configure OpenNext to the explicit no-cache mode, and kill the per-request error-log noise. The storefront already runs fine uncached (that IS today's de-facto state).
- [ ] Either way: the acceptance bar is "no more `set()` error noise in logs, and the chosen state is documented in AGENTS.md's deployment section".
- [ ] Commit: `fix(cache): <adopt R2 incremental cache | remove inert cache scaffolding> (M-24)`

### Task 4 — L-14: retention sweep

- [ ] Add a cron sweep (pattern of Plans 02/11 sweeps) with **two retention rules on `webhook_events`**, because the stated objective is "raw PII must not be held forever":
  - **Row deletion:** delete `webhook_events` rows with `status='done'` older than **90 days**.
  - **Raw-payload bounding (the PII fix) — terminal failures only, never pending/retryable:** `status <> 'done'` is **too broad** — it matches in-flight `processing` leases and released-but-still-retryable `failed` rows (Stripe retries a released event for ~3 days), and nulling their `raw_json` would destroy a payload still needed for replay. First **confirm the ledger's status vocabulary** (`webhook_events` uses a leased status — e.g. `processing` / `done` / `failed`; read `20260626120003_webhook_events.sql` + `20260728120000_webhook_events_stripe.sql`). Define **terminal-failure** conservatively as a non-`done` row **older than a window safely past Stripe's 3-day retract window** (e.g. **30 days**) so it cannot still be mid-retry. Then `update … set raw_json = null` for those rows only, keeping the row + failure metadata (`provider`, `provider_event_id`, `status`, timestamps). **Do not key the age on `processed_at`** — that column is only set on the `done`-write, so it is `NULL` on the very non-`done` rows this rule targets (the predicate would never fire). Key on a timestamp present on all rows — `created_at` (or `processing_started_at`); confirm which exists. Recent pending/retryable rows keep their `raw_json` and stay replayable.
  - `cms_audit_log`/`catalog_audit_log` rows older than **365 days** are deleted (keyed on `created_at`).
- [ ] **Use a key-selection CTE, not `DELETE … LIMIT`** — PostgreSQL does not support `DELETE … LIMIT` directly. Pattern for the batch-limited delete:

  ```sql
  WITH batch AS (
    SELECT id FROM webhook_events
    WHERE status = 'done' AND processed_at < now() - interval '90 days'
    ORDER BY processed_at, id
    LIMIT 500
  )
  DELETE FROM webhook_events AS e USING batch WHERE e.id = batch.id;
  ```

  Apply the analogous CTE per table with its own predicate (`webhook_events.processed_at`, `cms_audit_log.created_at`, `catalog_audit_log.created_at`). **State explicitly** that the 500-row limit is **per table per run** (not a shared budget), and that the 15-min cadence drains any backlog gradually.
- [ ] Unit tests: old `done` row deleted; a **terminal-failure** row (non-`done`, `created_at` > 30 days) → `raw_json` nulled, failure metadata intact; a **recent retryable/pending** row (non-`done`, within the retry window) → `raw_json` **preserved** (still replayable — this is the regression the terminal-only predicate prevents); a row with `NULL processed_at` is still correctly handled (predicate keys on `created_at`, not `processed_at`); young `done` kept; the CTE batch limit caps rows touched per table per run.
- [ ] Indexes supporting the predicates: check `webhook_events` for a usable `(status, processed_at)`/timestamp index; if absent add `create index if not exists webhook_events_done_prune_idx on webhook_events(processed_at) where status='done';` plus, for the raw-payload sweep, an index aiding `status <> 'done' and processed_at < …` if the table grows — backward-compatible, `if not exists`, auto-applies safely.
- [ ] Commit: `feat(worker): retention pruning for webhook_events and audit logs (L-14)`

## Database / migration work

Only the optional pruning index (Task 4) — additive, `if not exists`, no backward-compat concerns. The deletes themselves are cron-time DML, not migrations.

## External-system changes

- Task 3 **adopt** branch: creating/binding an R2 bucket for the cache is a gated Cloudflare mutation (operator approval). The **remove** branch has none.
- Task 2 may reveal a zone cache-rule need (dashboard, gated) — record rather than improvise.

## Tests

- **New:** shared header-list module test; feed header assertion; retention sweep matrix; (adopt branch) a preview-level cache-hit check.
- **Regressions caught:** headers dropped from API responses; feeds reverting to `no-store`; retention accidentally **deleting** a terminal-failure row (must be kept as evidence — only its `raw_json` is nulled); retention **nulling a still-retryable row's `raw_json`** (breaks replay); retention retaining PII in a terminal-failure row's `raw_json` past the evidence window.

## Verification

- **Local/unit:** `npm test` pasted.
- **Preview:** `curl -sI` outputs for an API route (headers present) and the feed (cache headers; `cf-cache-status` observation recorded either way); `wrangler tail` shows no cache `set()` error noise post-Task-3.
- **Live read-only:** after deploy, one feed fetch + one API fetch header check; after 24 h, row-count trend on `webhook_events` (should flatten once volume exists).
- **Live mutation:** none beyond the auto-applied index migration (and the gated R2 bucket if the adopt branch is chosen).

## Rollout / recovery

Each task ships independently; revert independently. **Stop signals:** any webhook consumer (Stripe delivery log) reacting badly to new response headers (none expected — response headers don't affect webhook senders' verification, but watch the first deliveries); merchant-feed fetch errors in Search Console/Meta diagnostics after the caching change (revert to `no-store` while investigating); retention deleting anything a live investigation needed (the 90-day window + `done`-only predicate is the guard — extend the window rather than disabling if contention arises).

## Acceptance criteria

- [ ] `/api/*` and `/admin*` responses carry the baseline header set (preview + live curl evidence).
- [ ] Feeds serve with `s-maxage` **and** a confirmed CDN cache `HIT` on the second request; if the zone shows `DYNAMIC`, L-32 is left **OPEN** with a gated zone-cache-rule follow-up recorded (header-only does not close it).
- [ ] The cache layer is in exactly one of the two resolved states, documented, with zero `set()` error noise in tail.
- [ ] Retention sweep unit-green: `done` rows deleted after 90 days via the key-selection CTE; **terminal-failure** rows (non-`done`, aged past the ~30-day terminal window, keyed on `created_at` not `processed_at`) **kept as evidence with `raw_json` nulled/redacted**; **still-retryable/pending** rows keep `raw_json`; the 500-row cap is per-table-per-run.

## Dependencies

- None hard. Coordinate `worker.ts` merge order with Plans 02/03/11 (same file, different sections). Task 3's adopt branch gates on an operator-approved R2 bucket.

## Risks / unresolved questions

- Whether Workers-origin responses are CDN-cacheable on this zone without extra cache rules (Task 2's observation decides; header-only is still a correct first step).
- M-24's adopt-vs-remove is genuinely open until the spike — both end states are acceptable; the only unacceptable state is today's half-wired one.
