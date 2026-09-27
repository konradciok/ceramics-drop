# Codebase audit — 2026-09-27

Scope: whole repo at `main` `f66dd81` (v0.15.0), plus live state read from the
connected services. Read-only: no code, config, or data was changed by this
audit.

## How this was checked

| Source | What was run | Result |
|---|---|---|
| Local toolchain | `npm ci`, `npm run lint`, `npm run typecheck`, `npx vitest run` | Lint 0 errors / 1 warning · typecheck clean · **3596 passed, 2 skipped** (274 files) |
| Dependencies | `npm audit --omit=dev`, `npm outdated` | 8 advisories (1 critical, 6 high, 1 moderate) — see F-01 |
| Sentry (`y9608071l-anna-ciok`, de region, project `ceramics-drop`) | Unresolved issues, last 30 d, plus issue detail | 20 unresolved; details in F-02, F-06, F-07 |
| Sentry (`anna-ciok-studio`, us region) | Unresolved issues | Empty — **not the org production reports to** |
| Supabase prod (`wnlysejenowymjdxlnaq`) | Migration list, security + performance advisors, read-only SQL on operational tables | 79/79 migrations applied (repo == prod); advisors in F-10/F-11; operational state in the section below |
| GitHub | Open PRs/issues, recent Actions runs, check runs | 6 open PRs, 1 open issue; see F-12 |
| Code reading | Checkout, Stripe webhook, `worker.ts`, admin + CMS-API access gates, signed print-asset route, auth redirects, middleware/CSP, rate limiters, `wrangler.jsonc` | Findings below |

Not available: the **Stripe MCP connector needs re-authorisation** (claude.ai →
connector settings), so the live webhook endpoint and payment settings were not
checked. Supabase log queries (`query_logs`) returned a backend error, so the
root cause of F-02 is inferred, not proven.

**Overlap with in-flight work:** dead code is already covered by
`docs/audits/2026-09-25-dead-code-audit.md` and its cleanup PR
[konradciok/ceramics-drop#331](https://github.com/konradciok/ceramics-drop/pull/331)
(open, CI green). This audit does not repeat those items; F-13 only lists what
is left after #331.

## Live operational state (verified 2026-09-27)

- `drops`: one row, `drop-1` = `active` (closes the 2026-09-11 launch-audit operator check).
- `orders`: 29 paid, 4 refunded, 12 expired, 2 failed; **all PLN**. Last paid order 2026-09-02. 0 pending older than 2 h, 0 paid orders without a confirmation email.
- `webhook_events`: 0 rows not `done`. `fulfilment_jobs`: 2 shipped, 1 cancelled. No stale reservations.
- `piece_state`: 126 rows; **125 are `showroom = true`** (120 sold, 5 available) and 1 is sold and not in the showroom. Showroom pieces are not purchasable, so **no ceramic piece can currently be bought** even though `drop-1` is `active`. This may be intentional (the drop has closed). If it is, consider ending `drop-1`. If it is not, it is lost revenue.
- `products`: 164 active (125 ceramics + 39 prints) + 2 archived. The 39-print curation **is live**.
- `cms_documents`: `page:print-pdp` published 2026-09-21; `page:home` published 2026-09-22.
- Promo codes: 0 defined. Gift cards: 0 issued, `spending_enabled = false`.

## Findings

Severity is about what could go wrong in production, scaled to the current
traffic. Each finding is labelled **Verified** (seen directly), **Inferred**
(follows from the evidence, not proven) or **Needs check** (an owner or
operator must confirm).

### HIGH

**F-01 · Next.js 16.2.9 has a critical advisory; no npm dependency automation** — Verified

- `next@16.2.9` falls in the range of 11 advisories. Two are **critical** and fixed only in `>=16.3.3`: GHSA-2xp9-vwfh-vxw4 (RCE in the Image Optimization API with AVIF) and GHSA-p293-qw3h-jr36 (Windows-hosted only, not relevant here). The high ones (fixed in `>=16.2.11`) are Server Action DoS, SSRF in rewrites, and a middleware bypass (Turbopack only, not relevant here). The moderate ones are response-body cache confusion and disclosure of Server Function endpoints.
- Exposure is reduced but not removed. Product images use a native `<img>`, not `next/image`. The worker bundle still includes the Next image-optimiser route, and whether OpenNext serves `/_next/image` has not been checked.
- `sharp@0.34.5` (direct dependency, used in the asset-processing container on CMS uploads) is affected by high-severity libvips/libheif CVEs. The fix is `0.35.x`, which is semver-major. The input comes only from the owner, which lowers the risk.
- Transitive highs: `postcss`, `fast-uri`, `brace-expansion`, `browserslist`, `nanoid`. `npm audit fix` resolves them without breaking changes.
- `.github/dependabot.yml` covers only `github-actions`. No automation raises npm security bumps, which is how this lag built up.
- **Action:** bump `next` and `eslint-config-next` to `16.3.6` (latest), run `npm audit fix`, and test `sharp@0.35` in the container. Then add an `npm` ecosystem to Dependabot, security updates only, grouped.

**F-02 · Supabase reads time out in production on every catalog-driven page type** — Verified (symptom) / Inferred (cause)

- Sentry shows these unresolved, recurring issues, all `TimeoutError` from `SUPABASE_QUERY_TIMEOUT_MS = 5000` (`src/lib/supabase-timeout.ts`), still firing within the last hour:
  - CERAMICS-DROP-1X "read media": 67 events, **escalating**, in PDP `generateMetadata`
  - CERAMICS-DROP-1Y "read print media": 37 events
  - CERAMICS-DROP-20 "read print pricing": 24 events
  - CERAMICS-DROP-1Z "read prints": 12 events
  - CERAMICS-DROP-23 "read media": 7 events, in the PDP server component
  - CERAMICS-DROP-21: 33 events, the CMS `getPublishedContent` for `product_notes/fine-art-prints`
  - CERAMICS-DROP-2G: the Google feed's `printCollectionDefinitions`
  - CERAMICS-DROP-2D: `getPrintAssetCoverage`
- The fallbacks work (tag `fallbackTier: last-known-good`), so pages render. But the timed-out requests stall for 5 s first, and a checkout-path read (`print pricing`) is among them.
- The data is tiny (`products` 192 kB, `product_media` 176 kB), so query cost is not the cause. **Inference:** the latency comes from connection setup or PostgREST between Cloudflare PoPs (events are US-geolocated) and `eu-west-1`, made worse by the per-request fan-out. Every uncached render reads the whole catalog several times (products → media → variants → pricing → CMS notes → collections), and caching is off by design (no tag cache; see AGENTS.md § Deployment).
- **Action:**
  1. Pull Supabase API latency for the timestamps in these Sentry events (the logs endpoint failed during this audit).
  2. Check the project's compute tier and pooler settings.
  3. Consider a short-lived in-isolate memo, a few seconds, for the read-only catalog snapshot. It must be scoped to ceramic structure/media and print designs, never to `piece_state`. That reduces fan-out without breaking the "no persistent tag cache" rule.
  4. Consider retry-once on timeout before falling back.

**F-03 · The `preview` Worker binds the production R2 bucket** — Verified

- `wrangler.jsonc` `env.preview.r2_buckets` → `anna-ciok-print-assets`, the production fulfilment-master bucket.
- Preview also runs the asset-jobs container, `CMS_API_ENVIRONMENT=integration`, and the site-media upload route. All of these **write** to `PRINT_ASSETS`.
- `docs/cms-api-integration-environment.md` steps 4 and 7 already say "do not reuse the production `PRINT_ASSETS` bucket … update the preview binding". That step was never done.
- Risk: preview or integration testing could overwrite or pollute production print masters or `site-media/`. Keys are content-addressed or revisioned, which limits (but does not remove) the damage.
- **Action:** create `anna-ciok-print-assets-preview` and rebind preview to it. Then confirm that preview's Supabase secrets point at the integration project (`ntqmlhcqmhjlcjtkeocc`), not prod.

### MEDIUM

**F-04 · Legacy JWT `service_role` key still in production** — Needs check

- `docs/STATUS.md` (2026-08-29) records that the production `SUPABASE_SERVICE_ROLE_KEY` is still a legacy JWT and needs rotating before the end-2026 deprecation. No later entry closes this.
- **Action:** schedule the rotation runbook (Plan 04 follow-up) for October so it is not squeezed against the deadline.

**F-05 · Five backend-remediation plans from 2026-08-12 are still not started**

- Plans **09** (admin auth hardening), **10** (global rate limiting), **12** (oversell/worker test coverage), **13** (InPost webhook hardening) and **14** (platform hygiene) are "not started" per `docs/STATUS.md` and the master index.
- Plan 10 matters concretely. Every limiter (`/api/checkout`, `/api/gift-cards/balance`, `/api/promo/validate`, `/api/interest`, `/api/newsletter`, `/api/auth/login`) is an **in-memory, per-isolate** Map (`src/lib/checkout-rate-limit.ts`, whose own comment says so). The stronger control is a Cloudflare WAF rule that STATUS still lists as "confirm deployed".
- Gift-card codes are 8 characters from a 32-symbol alphabet, about 40 bits (`generateGiftCardCode`). That is fine at the per-isolate limit. Revisit it before gift-card spending is turned on (`gift_card_settings.spending_enabled` is `false` today).
- **Action:** confirm the WAF rate-limit rule covers `/api/checkout`, `/api/gift-cards/balance` and `/api/promo/validate`, then close or reprioritise Plans 09–14 explicitly.

**F-06 · Sentry `environment=production` is polluted by local runs and probably by preview** — Verified (local) / Inferred (preview)

- CERAMICS-DROP-22 ("supabaseUrl is required", 225 events on 2026-09-09) came from `http://localhost:3212`, a Windows host with HeadlessChrome, tagged `environment: production`. `src/lib/sentry-options.ts` only suppresses `NODE_ENV === 'development'`. A local `next build && next start` or Playwright run uses `NODE_ENV=production` with the DSN from `.env.local`, so it reports as production.
- `env.preview.vars` does not set `SENTRY_ENVIRONMENT`. Unless it is set as a secret or build var, preview also reports as `production`. CERAMICS-DROP-2C (`checkout_missing_pmc_secret`, 4 events on 2026-09-14) may be preview, or may be a real gap in the production secret. Verify which.
- **Action:** set `SENTRY_ENVIRONMENT` explicitly per deploy target. Suppress sending when `SENTRY_ENVIRONMENT` is unset and the host is local. Triage and resolve the stale issues (CERAMICS-DROP-22, CERAMICS-DROP-2C, and the five cron-sweep issues 26/27/28/29/2A/2B/2F from 2026-09-22, which fired together and look like a single Supabase blip).

**F-07 · Worker/server errors in Sentry are unsymbolicated** — Verified

- Server-side frames read `worker.js:161281:22 (_)`, and several issue titles are a single minified letter (`o`, `f`: CERAMICS-DROP-21/24/25/2E/2G). Source maps for the OpenNext worker bundle are not being uploaded or applied to the `release` (`0.15.0`), which makes F-02 and any future incident much harder to triage.
- **Action:** upload the `.open-next` server bundle maps for the same `release` in the Workers Builds step, or use `@sentry/cloudflare`'s source-map flow.

**F-08 · CMS-API handlers can cache or return a `null` body as a successful 200** — Verified (code)

- This is the bug in open issue [konradciok/ceramics-drop#314](https://github.com/konradciok/ceramics-drop/issues/314), but it is **broader than the issue says**. Besides `collections-create.ts:103`, the same pattern appears in:
  - `collections-publication.ts:121`, `collections-restore.ts:109` (these also persist the null through `completeIdempotencyKey`)
  - `collections-save.ts:98`
  - `availability.ts:70` (`loadProductResponse` after the write)
- A concurrent delete or a read failure after the write makes the idempotency ledger replay `200 null` for up to the key's lifetime.
- **Action:** one small fix. Treat a `null` load after a write as `500 INTERNAL`, and release the idempotency key instead of completing it. Add tests for all five sites.

**F-09 · Documentation drift in the canonical agent context** — Verified

- **`AGENTS.md`**:
  - It never mentions **gift cards**, although there are 6 migrations, `gift_card_*` tables, a checkout branch (`src/server/gift-card-checkout.ts`), `/api/gift-cards/balance`, a cron sweep (`recoverBalanceOrders`), and `docs/gift-cards.md` + `docs/gift-card-balance-runbook.md`. The checkout error list and the `orders` schema (`gift_card_id`, `fulfilment_type`) are also missing gift-card fields.
  - It says the cron runs "five sweeps". `worker.ts` runs **eight**: balance recovery, abandoned, failed-action, stranded fulfilment, stranded asset jobs, Prodigi reconcile, and promo. It also leaves out the `print-asset-jobs` queue, its DLQ consumer, and the `PrintAssetProcessor` container/DO.
  - It says CMS-API content/pricing/shipping-rates/assets/uploads/jobs "return 404 NOT_IMPLEMENTED". Handlers for all of them now exist under `src/server/cms-api/handlers/`.
- **`docs/STATUS.md`**:
  - The "Fine-art prints" row says the 39-design curation is "not yet live". It is live (164 active products; migration `20260828120000` applied).
  - "Print PDP sections" says the publish is pending. It was published 2026-09-21.
  - "Versioning" says `0.14.0`. It is `0.15.0`, and the `0.16.0` release PR is open.
- **Action:** refresh these rows. Leave the `/api/returns` and `priceOf` drift alone, because PR #331 already fixes them.

### LOW

**F-10 · Supabase security advisor** — Verified
- 37 tables have RLS enabled with no policies. This is **intentional** here: all access is by the service role, so deny-all for anon/authenticated is correct. No action beyond an allowlist note.
- "Leaked password protection disabled": the only sign-in methods in use are OAuth (Google, and Apple which is not enabled). Enable the setting anyway, or disable the email/password provider, so a future password sign-in is not unprotected.

**F-11 · Supabase performance advisor** — Verified
- **Duplicate index** `prodigi_orders_order_id_idx` = `prodigi_orders_order_idx`. Drop one in a migration.
- 8 unindexed FKs (e.g. `orders.gift_card_id`, `gift_card_ledger.order_id`, `print_asset_jobs.{asset_id,upload_id}`, the `*_published_revision_fk`s) and 16 unused indexes. Tables are tiny, so this does not matter yet. Revisit if order volume grows.

**F-12 · Stale PR backlog** — Verified
- [#323](https://github.com/konradciok/ceramics-drop/pull/323) release 0.16.0: open since 2026-09-22. The latest CI/E2E run for it shows `action_required` because bot-triggered workflow runs need approval, so the release tag lags `main`.
- [#294](https://github.com/konradciok/ceramics-drop/pull/294) print-invoice line identity: open 18 days on an old base (`593b611`), mergeable state unknown. Rebase or close it.
- [#286](https://github.com/konradciok/ceramics-drop/pull/286) SEO docs progress: open 24 days.
- [#273](https://github.com/konradciok/ceramics-drop/pull/273) `release-please-action` 4→5 (major): open 26 days.
- [#330](https://github.com/konradciok/ceramics-drop/pull/330) cart/checkout shipping parity: GitHub CI green, but the **Workers Builds check failed** with no log output. Check it in the Cloudflare dashboard before merging.

**F-13 · Remaining code hygiene (not covered by #331)** — Verified
- The mojibake `ÔÇö` (a mis-decoded em dash) appears in comments in `src/app/api/checkout/route.ts` and `src/lib/inpost.ts`.
- Lint warning: unused `_args` in `scripts/backfill-fine-art-collections.test.ts:42`. The ESLint config does not ignore `_`-prefixed args, so either allow that pattern or drop the parameter.
- `scripts/backfill-fine-art-collections.ts` (a one-off) now overlaps the new `scripts/sync-fine-art-collections.ts`. Retire it or document it as historical.
- Items 15–26 of the 2026-09-25 dead-code audit still need an owner decision (listed there).
- `scripts/reconcile-orders.mjs` hand-mirrors the customer email copy (commit `a03fbf9` had to update both). This is a drift risk: import the shared strings instead, or add a test that asserts the two stay equal.

**F-14 · CSP is still report-only** — Verified
- `src/middleware.ts` sends only `Content-Security-Policy-Report-Only`, and the cutover to enforce is still pending. Reports go to worker logs (`console.log` in `/api/csp-report`), not Sentry, so nobody reviews them.
- **Action:** review about 2 weeks of `csp-report` log lines in Cloudflare Workers Logs, then switch to enforce. Consider sampling CSP reports into Sentry.

**F-15 · Accepted-by-design items (recorded so they are not re-raised)**
- Flat print shipping undercharges multi-frame orders. This is logged (`print_multi_frame_flat_shipping`) and was a settled decision (#5).
- `payment_intent.succeeded` on an `expired`/`failed` order alerts but does not auto-refund. This is rare by construction, because the cron cancels the PI before it expires the order.
- Ceramics are excluded from the merchant feeds (owner decision, 2026-09-21).

## What looked solid

These were reviewed and no defect was found:
- Checkout replay, idempotency and rollback in `src/app/api/checkout/route.ts`.
- The Stripe webhook's leased CAS ledger and 409-on-contention in `src/app/api/stripe/webhook/route.ts`.
- The under-fulfilment refund-before-relist ordering.
- Stripping of `X-Admin-Actor-Email` in `worker.ts`.
- The fail-closed Access gates (`src/lib/admin/access.ts`, `src/server/cms-api/access.ts`).
- HMAC verification with expiry on the signed print-asset URLs.
- `sanitizeNextPath` against open redirects.
- The `/api/inventory` fail-closed 503.
- Sentry event scrubbing.

## Recommended order

1. **This week:** F-01 (Next.js bump + `npm audit fix`), F-03 (preview R2 bucket), F-06 (Sentry environment tagging, plus triage of stale issues).
2. **Next:** F-02 (Supabase timeout root cause, plus memoisation or retry), F-07 (source maps, which also makes F-02 easier), F-08 (#314 widened).
3. **Before end of October:** F-04 (service-role key rotation), F-05 (WAF check, decisions on Plans 09–14), F-09 (doc refresh), merge or close the stale PRs (F-12).
4. **Backlog:** F-10, F-11, F-13, F-14.

Owner decision needed: are all 125 ceramics meant to be in showroom (not purchasable) while `drop-1` is still `active`?
