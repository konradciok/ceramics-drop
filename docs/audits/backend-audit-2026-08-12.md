# Backend Audit — 2026-08-12

- **Author:** Claude Code (Fable 5), multi-agent read-only audit — 11 domain code auditors + 4 official-docs researchers + 5 adversarial verifiers, reconciled against live system state.
- **Scope:** the entire backend — checkout/payment lifecycle, Stripe webhook & fulfilment orchestration, Supabase schema/RPCs/RLS, the Prodigi print-on-demand queue pipeline, print-asset signing + R2, customer-account auth, the admin surface + Cloudflare Access gate, all inbound webhooks (Stripe/InPost/Resend/Prodigi), cron/queue/DLQ reliability, secrets/config, and test/observability coverage.
- **Method:** static code trace **+ live read-only validation** of the connected systems — Supabase project `wnlysejenowymjdxlnaq` (tables, migrations, advisors, RLS), the live Stripe account `acct_1Qiwd0J0KFK9lrjH` (webhook endpoints, refunds, orders), Cloudflare Workers/Builds, Sentry, Resend. **No mutation was performed on any system**: no code changed (this report file is the only repository change), no migration applied, no Stripe/Supabase/Cloudflare config touched, and no mutating or customer-facing request issued against production (the live validation used read-only API calls only). Every finding of consequence was cross-checked by an independent adversarial verifier that tried to refute it.
- **This is an audit stage only.** Do not implement any recommendation before it is accepted.

> **Evidence legend:** `[CONFIRMED-LIVE]` proven against the running Supabase/Stripe/Sentry state · `[CONFIRMED-CODE]` proven by reading current source + dependency internals · `[INFERENCE]` strong reasoning, not independently confirmed · `[UNVERIFIED]` material area that could not be confirmed read-only (test named in §15).
>
> **Severity** (by real impact × likelihood, not technology): `CRITICAL` money/data loss, auth bypass, or a live production incident · `HIGH` serious security/integrity/reliability risk · `MEDIUM` real defect, no direct critical risk · `LOW` quality/maintenance/hardening · `OPPORTUNITY` (in §13) growth, not a defect.
>
> Finding IDs (`C-`, `H-`, `M-`, `L-`) are stable references used throughout. Severities below are **as adjudicated after adversarial verification**; where verification re-graded a finding from its first pass, that is stated inline.

---

## 1. Executive Summary

The backend is, on the whole, **carefully engineered and unusually well-reasoned** for a solo-studio storefront. The money-critical paths that matter most — atomic inventory reservation, checkout amount computation, Stripe signature verification, webhook idempotency, and print-asset signing — are correct and defensively coded, with extensive rationale comments and a real test suite. Adversarial verification *refuted* the scariest first-pass finding (a suspected unauthenticated admin bypass), which is a good sign of the codebase's underlying discipline.

Two findings nonetheless rise to the top and both concern **fulfilment integrity on the money path**:

1. **`CRITICAL` C-1 — refunds are silently un-reconciled in production.** The live Stripe webhook endpoint does **not** subscribe to `charge.refunded`, yet that event is the *only* thing that flips a refunded order to `refunded`, relists the one-of-a-kind ceramic, cancels Prodigi, and reverses GA4 revenue. This is **confirmed on a real production order**: a genuine 139 zł refund left order `8be30881…` still `paid` and piece `s15` still `sold`, permanently unsellable, with revenue never reversed. It recurs on every future refund and, for a Dashboard-initiated *print* refund, would let Prodigi print & ship an item the customer was already refunded for.

2. **`HIGH` C-2 — automated print fulfilment cannot succeed in production** (first-pass CRITICAL, verified down to HIGH because it is latent and fails loudly-and-recoverably). The Cloudflare Queue consumer calls `getSupabaseAdmin()` → `getCloudflareContext()` outside the request AsyncLocalStorage that only the `fetch` handler populates, so **every** queued print job throws on its first statement, exhausts 10 retries, and dead-letters — nothing reaches Prodigi. It has never fired only because **no print order has been placed in production yet** (`fulfilment_jobs = 0`). The first real print sale takes the customer's money and produces nothing until someone manually reconciles.

Beyond these, the highest-value themes are: (a) **operational recoverability gaps** — several failure modes are `console.error`-only or depend on alert channels (DLQ email, worker-context Sentry) that may themselves be misconfigured (M-15, M-16, M-10); (b) **a whole print→Prodigi→queue→callback pipeline that has never executed in production** (L-15) and will have its maiden run on a paying customer; (c) **Postgres data-API hardening** — four money-path RPCs retain default `PUBLIC EXECUTE` and `piece_state` carries out-of-band anon `SELECT` policies that exist in the live DB but in **no migration** (M-2, M-3); and (d) **Stripe refund-event modernization** (H-3/M-28) — the integration keys off the legacy `charge.refunded` model and the API-version rationale in the docs is factually wrong.

The biggest *opportunities* flow directly from the gaps: a **webhook-config drift guard** and a **refund reconciliation sweep** would have caught C-1 automatically; a **queue-context lint guard** and a **one-shot production rehearsal** would catch C-2 before the first customer does; and a **native Workers rate-limit binding** would turn the per-isolate in-memory limiters (which do not throttle globally) into real controls.

**Nothing here indicates customer money was mishandled** — the one real refund was correctly paid out by Stripe; the damage from C-1 is to *merchant* inventory/analytics/order-state integrity, not the buyer.

**Adjudicated finding counts:** 1 CRITICAL · 1 HIGH · 29 MEDIUM · 44 LOW (75 distinct, after verification re-graded H-2→LOW, M-1→LOW, M-6→LOW, C-2 CRITICAL→HIGH, H-1 HIGH→MEDIUM). Plus 15 incomplete/partial features (§6) and 23 development opportunities (§13).

---

## 2. Architecture Map

**Runtime:** Next.js 16 App Router, built with **webpack** (never Turbopack — a hard, correctly-enforced constraint), bundled by `@opennextjs/cloudflare` 1.19.11 and served from a single **Cloudflare Worker** (`ceramics-drop`) on a paid plan. A custom `worker.ts` wraps the OpenNext `fetch` handler and adds a `queue()` consumer, a `scheduled()` cron, and the admin access gate.

**Entry points:**
- **`fetch`** — all storefront + API routes (`src/app/api/**/route.ts`, 34 routes) run through the OpenNext handler inside `runWithCloudflareRequestContext` (the only place `getCloudflareContext()` is populated).
- **`queue`** — consumer for the `prodigi-fulfilment` Cloudflare Queue (+ an alert-only `prodigi-fulfilment-dlq`).
- **`scheduled`** — a `*/15` cron: expire abandoned checkouts (cancel PI + free pieces) and alert on `failed_action_required` fulfilment jobs.

**Data plane:** **Supabase** (Postgres 17, `eu-west-1`), accessed **exclusively via the service-role key** (`getSupabaseAdmin()` on the request path; `supabaseFromEnv(env)` in cron/queue). RLS is enabled on every table but only `piece_state` has policies — the posture is "deny-all + service-role-only." **No Supabase Edge Functions** exist; all server logic is in the Worker.

**External integrations (all detected in-repo and/or in live config):**
| System | Role | Auth / entry |
|---|---|---|
| **Stripe** (`^22.2.0`, API `2026-05-27.dahlia`) | Payments, refunds, invoices | PaymentIntents; webhook at `/api/stripe/webhook` (signature-verified) |
| **Supabase** | Orders, inventory (`piece_state`), catalog shadow tables, CMS, auth | service-role; customer auth via JWKS/jose |
| **InPost ShipX** | Ceramic shipping + returns | REST; inbound webhook `/api/inpost/webhook?token=` |
| **Prodigi** (Print API v4) | Print-on-demand fulfilment | `X-API-Key`; Cloudflare Queue → `postOrder`; callback `/api/webhooks/prodigi/[token]` |
| **Cloudflare R2** (`anna-ciok-print-assets`) | High-res print masters | HMAC-signed URLs via `/api/print-assets/[id]` |
| **Cloudflare Queue** (`prodigi-fulfilment` + DLQ) | Async print submission | producer in webhook; consumer in `worker.ts` |
| **Resend** | Transactional email + newsletter | REST; inbound Svix webhook `/api/resend/webhook` |
| **Meta CAPI + GA4 MP** | Server-side conversions | from webhook, consent-gated, `waitUntil`-deferred |
| **Cloudflare Access** | `/admin` + `/api/admin` gate | JWT (`Cf-Access-Jwt-Assertion`) verified in `worker.ts` |
| **Sentry** | Error monitoring | `@sentry/nextjs` (request path); worker-context init is questionable (M-16) |

**Core business flows traced end-to-end:** ceramic checkout (reserve→PI→webhook→InPost), print checkout (validate asset→PI→webhook→queue→Prodigi→callback), refund/dispute convergence, abandoned-checkout expiry cron, customer-account order history, admin mutations (refund/shipment/release/resend).

---

## 3. Audited Systems — coverage & confidence

| Area | Depth | Confidence |
|---|---|---|
| Checkout / payment initiation | Full trace + live Stripe | `[CONFIRMED-CODE]` + `[CONFIRMED-LIVE]` |
| Stripe webhook / refund / conversions | Full trace + live endpoint config + live refund/order state | `[CONFIRMED-LIVE]` |
| Supabase schema / RLS / advisors | Full (live `list_tables`, `get_advisors`, `list_migrations`) | `[CONFIRMED-LIVE]` |
| Supabase RPCs (reserve/publish/link) | Full SQL read | `[CONFIRMED-CODE]` |
| Prodigi queue pipeline | Full code trace; **never run in prod** | `[CONFIRMED-CODE]` / `[UNVERIFIED]` runtime |
| Print-asset signing + R2 | Full code; **R2 bucket public-access posture** unread | `[CONFIRMED-CODE]` / `[UNVERIFIED]` bucket |
| Customer auth / accounts | Full code trace | `[CONFIRMED-CODE]` |
| Admin gate + mutations | Full code + adversarial verify | `[CONFIRMED-CODE]` |
| Inbound webhooks (InPost/Resend/Prodigi) | Full code trace | `[CONFIRMED-CODE]` |
| Cron / queue / DLQ / observability | Full code + OpenNext internals | `[CONFIRMED-CODE]` |
| Secrets / config | `.env.example`, `wrangler.jsonc`, code refs | `[CONFIRMED-CODE]`; **secret values** not read |
| Tests | Enumerated suites vs critical flows | `[CONFIRMED-CODE]` |

**Could not be verified read-only** (full list in §15): live Stripe **v2 Event Destinations** (the connector exposes only legacy webhook endpoints); actual **secret values / presence in prod** (`ADMIN_ALLOWED_EMAILS`, `RESEND_API_KEY`, Supabase key format); the **R2 bucket public-access** posture; the **Cloudflare Access application policy**; and the entire print/queue pipeline **at runtime** (0 executions in prod).

---

## 4. Critical & High Findings

### C-1 · `CRITICAL` · `[CONFIRMED-LIVE]` — `charge.refunded` is not subscribed on the live Stripe endpoint; the entire refund-reconciliation pipeline is dead in production

- **Component:** Stripe webhook subscription (config) + refund lifecycle.
- **Evidence:**
  - Live Stripe endpoint `we_1TgXEgJ0KFK9lrjHNbgIUSbr` (`https://anna-ciok.studio/api/stripe/webhook`) `enabled_events` = `payment_intent.{created,processing,requires_action,succeeded,payment_failed,canceled}`, `charge.captured`, `charge.dispute.{created,closed}` — **`charge.refunded` is absent** (single endpoint, `has_more:false`).
  - The handler for `charge.refunded` exists and is correct: `src/lib/webhook.ts:69-78` → `releaseSale` at `src/app/api/stripe/webhook/route.ts:454-573`, which is the **only** code that (a) CAS-flips the order `paid→refunded`, (b) relists `piece_state` `sold→available`, (c) calls `cancelPrintFulfilment` on the webhook path, and (d) fires the GA4 revenue reversal (`sendRefundConversion`, `:515-528`).
  - The admin/CLI refund `refundOrder` (`src/lib/admin/actions.ts:49-84`) deliberately creates only the Stripe refund + cancels Prodigi inline, then returns `"Status zaktualizuje webhook."` — it does **not** touch `orders.status` or `piece_state`, explicitly delegating that to the (missing) webhook.
  - **Live production proof `[CONFIRMED-LIVE]`:** exactly one refund exists in Stripe (`pyr_…Qoly`, 139 zł BLIK, `succeeded`, `pi_3Tw1WWJ0KFK9lrjH0YnXK5rg`). The corresponding order `8be30881-4f02-44a6-9627-221f54c67125` is **still `status='paid'`** and its piece **`s15` is still `status='sold'`** (never relisted). Zero orders are in `refunded` status DB-wide.
- **Impact:** Per full refund from *any* origin (admin UI, `orders` CLI, or Stripe Dashboard): the order stays `paid` forever (wrong dashboards/accounting; a later `succeeded` redelivery would still invoice it), the one-of-a-kind ceramic stays `sold` and never returns to sale (**permanent lost re-sale revenue on unique inventory**), and GA4 revenue is never reversed. For a **print** order refunded from the Stripe Dashboard, `cancelPrintFulfilment` never runs → Prodigi prints & ships an item the customer was refunded for → **direct financial loss**. It also disarms `releaseSale`'s `pending→refunded` "park" guard, so a Dashboard refund during a delayed `succeeded` delivery no longer prevents the late success from fully fulfilling an already-refunded payment.
- **Likely failure scenario:** already occurring — every refund silently leaves inventory/analytics/order-state inconsistent; the studio cannot re-sell a refunded piece without manual SQL.
- **Recommended fix:** Add `charge.refunded` to the endpoint's `enabled_events` (config only — the code is already correct, idempotent, and crash-resume-safe). Strongly consider migrating to the modern refund event family (`refund.created`/`refund.updated`/`refund.failed`) per H-3 in the same change. Belt-and-braces: (a) have `refundOrder` perform the `paid→refunded` CAS + relist directly so admin refunds don't depend on webhook delivery; (b) extend `scripts/reconcile-orders.mjs` to reconcile Stripe refunds against `orders.status='paid'`; (c) add a config-drift guard (see §13 Opp-2).
- **Scope / dependencies:** S (one event subscription) + M (reconcile/guard hardening). No schema change. Adding the event is backward-compatible.

### C-2 · `HIGH` · `[CONFIRMED-CODE]` (first-pass CRITICAL; verified down to HIGH — latent + loud + recoverable) — the Prodigi queue consumer calls `getCloudflareContext()` outside the request ALS, so every production print job dead-letters and nothing reaches Prodigi

- **Component:** Cloudflare Queue consumer / `process-job` / OpenNext runtime.
- **Evidence (verified against dependency internals):**
  - OpenNext defines the context symbol as a **getter over an AsyncLocalStorage store**: `node_modules/@opennextjs/cloudflare/dist/cli/templates/init.js:13-17` (`Object.defineProperty(globalThis, Symbol.for("__cloudflare-context__"), { get(){ return cloudflareContextALS.getStore(); }})`), and the store is set **only** inside `runWithCloudflareRequestContext` (`init.js:21-24`). `getCloudflareContextSync()` (`cloudflare-context.js:31-48`) **throws** when the store is undefined and not in SSG.
  - The generated worker wraps **only `fetch`** in that context (`templates/worker.js`). The custom `worker.ts:63-70` `queue()` calls `processJob(msg.body, env, ctx)` **directly**, outside any context init.
  - `processJob` calls `getSupabaseAdmin()` as its first DB op (`src/server/fulfilment/process-job.ts:99`), which resolves `getCloudflareContext().env` synchronously (`src/lib/supabase.ts:16-18`). In a real queue delivery this **throws before any DB write or claim**.
  - The authors already know this: `scheduled()`/DLQ paths deliberately use `supabaseFromEnv(env)`/`stripeFromEnv(env)` (`worker.ts:183-184,257`), and `supabase.ts:5-7` documents that `getCloudflareContext()` is unavailable in non-fetch handlers — `processJob` was simply missed.
  - Disposition: `src/server/fulfilment/queue-disposition.ts` returns `'retry'` for a plain `Error` → `msg.retry()` → `max_retries:10` → `dead_letter_queue` (`wrangler.jsonc:41-43`). Precise mode is **retry→DLQ-after-10**, not silent-ack-drop.
  - Masked in dev: `enqueue.ts:47-57` runs `processJob` **inline in the webhook fetch ALS** when `FULFILMENT_QUEUE` is unset; `process-job.test.ts:28` mocks `getSupabaseAdmin`. So neither local dev nor unit tests catch it.
  - **Latent:** `fulfilment_jobs = 0`, `prodigi_orders = 0` in prod `[CONFIRMED-LIVE]`; no print order has ever been placed. Print pricing is live, so the feature is purchasable.
- **Impact:** The first (and every) paid print order: job row + queue message created, then all 10 deliveries throw before any DB write (no claim, no `last_error`) → message dead-letters. The `fulfilment_jobs` row is stranded in `queued` (which the `failed_action_required` sweep does **not** cover — M-10). Customer paid; nothing submitted to Prodigi.
- **Why HIGH not CRITICAL, and the caveat that pushes it back up:** verification down-graded it because the failure is *loud* (DLQ → Sentry + studio email) and *recoverable* — **but recovery must stay on the queue path**: a dead-lettered paid print job is recovered by re-driving it through `enqueueProdigi()` → `FULFILMENT_QUEUE` → `process-job.ts` (which owns idempotency/retry/status), or by stop-and-escalate + manual reconciliation against Prodigi state. It is **not** recovered by `npm run prodigi` — the CLI blocks live production order creation by design, and hand-submitting would bypass the idempotency key and status tracking. **However** that loudness is not guaranteed: the DLQ email is skipped silently if `RESEND_API_KEY`/`STUDIO_NOTIFY_EMAIL` are unset (`worker.ts:145-153`), and worker-context Sentry may never initialize (**M-16**). If both alert channels are dark, this becomes a silent money-taking failure and effectively CRITICAL. Treat it as a **P0 pre-launch blocker for prints** regardless of label.
- **Recommended fix:** Thread `supabaseFromEnv(env)` through `processJob` (and inject a client into `getAssetForFulfilment`), mirroring the cron path. Add an ESLint/invariant guard forbidding `getCloudflareContext`-dependent imports under `src/server/fulfilment/**` (Opp-6). Then run one controlled queue rehearsal in a `wrangler` preview before the first live print sale (§15).
- **Scope / dependencies:** S (~20-line client injection + test mocks) + one preview rehearsal. No schema change.

### H-3 · `MEDIUM` · `[CONFIRMED-CODE]` (Stripe research flags HIGH) — refund handling uses the legacy `charge.refunded`/`amount_refunded` model; `refund.failed` (async refund failure) is entirely unhandled

- **Component:** refund event model. **Files:** `src/lib/webhook.ts:69-78`; no `refund.failed` handler anywhere in `src/`.
- **Detail:** Stripe now recommends `refund.created` (+ `refund.updated` for ARN/reversal, `refund.failed` for async failure). A card refund can be accepted, the piece relisted/re-sold, then **up to 30 days later** the issuer rejects the refund (`refund.failed` — closed account/expired card): funds return to the Stripe balance, the customer never got their money, and nothing notices — the order stays `refunded`. The failure scenario is `[INFERENCE]` (needs a real failed refund to observe).
- **Priority note:** contingent on C-1 (the refund leg is currently unreachable). Fix together with C-1. **Source:** https://docs.stripe.com/refunds#failed-refunds
- **Fix:** subscribe + handle `refund.created`/`refund.updated`/`refund.failed`; treat refund status as pending until webhook-confirmed; add a `refund.failed` → studio-alert path. Scope: M.

### H-4 · `MEDIUM` · `[CONFIRMED-LIVE]` (first-pass HIGH-disputed) — live Sentry error "supabaseUrl is required." on the admin CMS content editor

- **Component:** admin content editor Server Component. **Files:** `src/app/admin/content/[kind]/[slug]/page.tsx:16` → `getContentEditorState` → a Supabase client built via `createClient(env.SUPABASE_URL, …)` (`src/lib/supabase.ts:9-13` / `src/lib/admin/clients.ts:35`).
- **Detail:** `createClient` throws exactly this message when the URL is undefined. Sentry shows 6 events over ~20 h, all clustered right after the 0.14.0 build window, **0 users affected**, on a `force-dynamic` page. **Most-likely root cause (`[INFERENCE]`):** a build-time / route-collection pass evaluated the page's data path without runtime secrets — benign build noise, not a runtime break for a real admin. If instead it reproduces at runtime, the admin editorial surface (product notes + the print-PDP document) is 500ing and the draft→preview→publish cycle is blocked.
- **Verification needed (§15):** open the exact Sentry event and read its request host (preview worker vs `anna-ciok.studio`); check whether `SUPABASE_URL` is bound in that deployment. If preview-without-secrets → fail-soft like `/konto`; if production → the secret binding regressed. **Downgraded to MEDIUM** pending that check.

---

## 5. Medium & Low Findings

Grouped by domain; each carries its ID (see the master ledger for full evidence), primary file, and one-line essence. Severity is post-verification.

### Stripe / payments / webhook
- **M-5 · `MEDIUM` · [INFERENCE]** — a double-paid private-sale link turns `markPaid` into a permanent webhook 5xx loop: the second order's `pending→paid` CAS violates the `private_sales_one_paid_order` partial unique index (`webhook/route.ts:207-218`), Stripe retries for 3 days, money captured with no auto-refund. Fix: catch PG `23505` on the CAS → fail + idempotent `refund_<pi>`.
- **M-20 · `MEDIUM`** — heavy synchronous work (markPaid + up to 6 email attempts + invoice + InPost/enqueue) runs before returning 2xx (`webhook/route.ts:206-810`); vendor latency inflates Stripe failure metrics + delays customer email. Ack fast, drive from a queue. https://docs.stripe.com/webhooks
- **M-21 · `MEDIUM`** — the idempotency ledger's initial "seen" SELECT swallows its error (`webhook/route.ts:144-150`); a transient lookup failure → false `deduped:200` → a retryable fulfilment event is dropped permanently. Check + throw.
- **M-22 · `MEDIUM` · [INFERENCE]** — in-flight-lease dedupe answers 200 during the 5-min lease (`:155-162`); isolate death (or a >Stripe-timeout handler that later throws) permanently drops the event. Respond non-2xx for an active lease; reserve dedupe-200 for `done`.
- **M-28 · `MEDIUM`** — the API-version model is documented wrong: `stripe-node` v22 **pins** its bundled version (`2026-05-27.dahlia`) on every request; it does **not** use the account default, so `npm update stripe` silently moves all API calls. Pass `apiVersion` explicitly or fix the comment/AGENTS.md. https://docs.stripe.com/sdks/set-version
- **H-1 · `MEDIUM` · [CONFIRMED-CODE]** (first-pass HIGH; verified down — narrow trigger) — `markPaid`'s `reserved→sold` UPDATE discards its `{error}` (`webhook/route.ts:275-279`), uniquely among all mutations in the file; an *asymmetric* transient failure (write fails, the separate COUNT succeeds) → under-fulfilment **auto-refund of a legitimate payment** + pieces stuck `reserved` on a `failed` order, and it 200s (no self-correcting retry). Rare (a broad DB failure also fails the COUNT, which throws → retry → no refund), but silent when it fires. One-line fix: destructure + throw.
- **L-4/L-5/L-6/L-7** (`LOW`) — lease release/`done` not CAS-scoped to `claimedAt` (`:198-204`); `ensureInvoiced` swallows all errors (no retry/backfill); 5 subscribed events are unhandled no-ops that still write full `raw_json` rows and `charge.dispute.created` produces no alert (deadline risk); `markPaid` post-processing catch is console-only for order/items load failures.

### Supabase / data
- **M-2 · `MEDIUM` · [CONFIRMED-CODE]** — four money-path RPCs (`reserve_pieces`, `reserve_private_sale_pieces`, `publish_cms_version`, `publish_print_asset_revision`) keep default `PUBLIC EXECUTE`, exposed at PostgREST `/rpc`. Invoker-rights + deny-all RLS neutralise *writes*, but `piece_state`'s live anon `SELECT` policies (M-3) + default table grants let anon take `SELECT … FOR UPDATE` locks (lock-contention DoS on the checkout path during a drop) and use `reserve_private_sale_pieces` as an unthrottled token oracle. One migration: `revoke execute … from public, anon, authenticated; grant … to service_role`. https://supabase.com/docs/guides/database/hardening-data-api
- **M-3 · `MEDIUM` · [CONFIRMED-LIVE]** — `piece_state` has anon `SELECT` policies in the **live DB but in no migration** (out-of-band drift; breaks the migrations-are-truth invariant), including a **duplicate permissive pair** (advisor `0006`). Exposes `status/reserved_until/order_id`; would open a real read/lock surface the moment a browser publishable-key client is added. Drop both in a migration (restore deny-all); investigate origin. https://supabase.com/docs/guides/database/database-advisors?lint=0006_multiple_permissive_policies
- **M-4 · `MEDIUM`** — a NULL/zero ceramic `price_pln` fails **open** to a sellable 0 zł one-of-a-kind piece under `CATALOG_SOURCE=db`: no `CHECK > 0` (`catalog_shadow.sql:36-41`) and `price: row.price_pln ?? 0` (`mappers.ts:62`). A fat-fingered admin `0`/manual NULL sells a unique piece for the shipping fee. Zod `.positive()` + fail-closed mapper.
- **M-25 · `MEDIUM` · [UNVERIFIED]** — Supabase keys may still be the legacy JWT format (deprecating end-2026) rather than `sb_secret_`/`sb_publishable_`. Verify + rotate. https://supabase.com/docs/guides/api/api-keys
- **L-9…L-13, L-17, L-20** (`LOW`) — `publish_cms_version` writes its audit row outside the RPC txn (unchecked); `reserve_*` accept unvalidated `p_ttl_secs`; `update_product_status_guarded` `FOR SHARE` can't block a phantom variant INSERT; unindexed FKs (`product_media.variant_id`, `products.drop_id`, `prodigi_orders.order_id`) + free-text status columns without CHECK constraints (a typo'd status silently frees the one-active-job slot); intentional-but-undocumented FK gaps on `order_items`/`piece_state`; USD/CAD are dead-but-valid CHECK values by design.

### Prodigi / print fulfilment / R2
- **M-10 · `MEDIUM`** — no watchdog for jobs stranded in `queued`/`fulfilment_submitting`/`failed_retryable`; the cron sweep covers only `failed_action_required` (`worker.ts:256-264`). Widen the sweep to any non-terminal job older than ~2 h. *(This is what makes C-2's stranded `queued` rows invisible.)*
- **M-11 · `MEDIUM`** — no `AbortSignal` timeout on any Prodigi call (`prodigi/client.ts:45-76`); a hung endpoint stalls the queue consumer and the inline callback response. Add `AbortSignal.timeout`.
- **M-12 · `MEDIUM` · [UNVERIFIED]** — loss of a single Prodigi callback (transient 500 our side) may permanently miss `shipped`; no reconciliation poll, Prodigi retry semantics unconfirmed. Add a cron reconciliation of non-terminal `prodigi_orders`.
- **M-14 · `MEDIUM` · [INFERENCE]** — 7-day bearer signed-URL TTL, and the signed URL is echoed back by Prodigi and persisted forever in `prodigi_orders.prodigi_raw_json` (`callbacks.ts:158`). Shorten TTL to 24–48 h; redact the URL/sig before persisting (`redactSignedPrintAssetUrl` already exists).
- **M-26 · `MEDIUM`** — Prodigi create-order `outcome` is never checked (`process-job.ts:189-190`); `CreatedWithIssues`/`OnHold` read as success while the order stalls in Prodigi. Branch on `outcome`, surface the `issues` array. https://www.prodigi.com/print-api/docs/reference/
- **L-19, L-21, L-22, L-23, L-24, L-25** (`LOW`) — `enqueueProdigi` key embeds `PRODIGI_ENV` so a sandbox→live flip collides with the per-order unique index → 5xx loop; queue consumer swallows the retry error (no logs for 10 deliveries — this is why C-2 leaves no trace); Prodigi contract assumptions (PLN `recipientCost`, 409-body idempotency, `InProduction` stage) unexercised; no `PRINT_ASSET_TOKEN_SECRET` rotation story (a GitHub copy already drifted); the signed route prefers R2 `httpMetadata` content-type over the DB-validated column; R2 bucket public-access posture `[UNVERIFIED]`.

### Auth / accounts / admin
- **M-7 · `MEDIUM` · [INFERENCE]** — no CSRF/Origin defense on state-changing `/api/admin/*` (`end-drop`, `toggle-showroom`, `refund`); they rely solely on the Access cookie perimeter. On a cross-site request the edge injects the JWT → gate passes for a forged request from a logged-in operator. Add an Origin/`Sec-Fetch-Site` check + reject non-JSON content-types in a shared admin preamble.
- **M-1 · `LOW` · [PARTIAL]** (first-pass MEDIUM; verified down — purely latent) — guest-order backfill guards on `!email_confirmed_at && !confirmed_at` (`link-orders.ts:34`), OR-semantics; `confirmed_at` is also set by phone confirmation, so a phone-confirmed/unverified-email user could sweep a victim's guest orders — **but only Google/Apple OAuth are wired today (both set `email_confirmed_at`)**. Tighten to `!email_confirmed_at` before any phone/OTP provider is enabled.
- **M-6 · `LOW` · [PARTIAL]** (first-pass MEDIUM; verified down — documented defense-in-depth) — the admin email allowlist is fail-**open** when `ADMIN_ALLOWED_EMAILS` is unset (`access.ts:78,85`, returns `ok` for any valid AUD JWT). The repo frames it as secondary to the Cloudflare Access application policy (`.env.example:114`). LOW as designed; rises to MEDIUM+ **only if** the Access app policy is broad (dashboard state — §15). Recommend fail-closed + a startup warning on a prod hostname.
- **H-2 · `LOW` · [REFUTED]** (first-pass HIGH) — the worker admin gate matches the raw un-normalized pathname, so `%61dmin`/`%2f`/`//`/case variants **evade the gate** — but verification proved they **also fail to reach the admin handler**: OpenNext + NextServer dispatch static routes by **exact string comparison with no decode** (the decode-fallback lives only in the standalone `next start` router-server, which OpenNext replaces). Every path Next routes to an admin handler is exact `/api/admin/…`, which the gate *does* match; variants 404. **Not an active bypass.** Residual: a genuine latent fragility — normalize/decode in `isAdminPath` as defense-in-depth in case OpenNext/Next ever change dispatch behavior. (Test in §15.)
- **L-16, L-26, L-27, L-29, L-30, L-31** (`LOW`) — `orders.id` is the client-supplied attemptId (order-existence oracle via 409 variants, infeasible at 122-bit entropy); jose verify doesn't pin the JWT `algorithms` (defense-in-depth; not exploitable via JWKS-by-kid); `/api/auth/login` lacks the Origin check `signout` has (real protection is the PKCE verifier); admin audit actor can fall back to an un-stripped header under local bypass; `clients.ts` stale "gitignored" comment + `ADMIN_*` overrides can silently repoint prod admin at another Stripe/Supabase account; `/api/returns` lets any order-UUID holder create a real return shipment (deliberate capability token, well-hardened; residuals).

### Reliability / observability / secrets
- **M-15 · `MEDIUM`** — the cron sweep's most valuable signal — a `succeeded/processing` PI on a still-`pending` order (a *missed* `payment_intent.succeeded`) — is `console.warn`-only (`worker.ts:236`, `expire-orders.ts:42-44`); no Sentry, no email. Worse, the `.catch(console.error)` on the `waitUntil`'d sweeps means a dead abandoned-sweep still shows green in Cron Past Events. Route paid-on-pending through the studio-alert machinery. https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- **M-16 · `MEDIUM` · [INFERENCE]** — `Sentry.init` runs only in Next instrumentation (fetch path); the custom worker bundle has no init, so `captureMessage` in `queue()`/`scheduled()`/DLQ may be a **silent no-op on a cold isolate** — precisely the poison-message/failed-action alerts. This directly undercuts C-2's "fails loudly" mitigation. Init Sentry at the worker entry (`@sentry/cloudflare withSentry`). https://docs.sentry.io/platforms/javascript/guides/cloudflare/
- **M-17 · `MEDIUM`** — `.env.example` omits required secrets `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` and `CMS_PREVIEW_SECRET` (plus several minor ones); a DR redeploy provisioned from it has **every checkout 502** (`checkout/route.ts:262`), invisible until first checkout. Add them + a test asserting every `env.` name in `src/` appears in `.env.example`.
- **M-18 · `MEDIUM`** — `worker.ts` has **zero test coverage**, including `cancelIntent`'s Stripe-status→`CancelOutcome` mapping — the single guard between the cron and relisting a paid piece (a future edit mapping `processing→canceled` oversells with no test failing). Extract + matrix-test.
- **M-19 · `MEDIUM`** — `reserve_pieces`/`reserve_private_sale_pieces` SQL is **untested** — every test mocks the RPC that prevents double-selling; the oversell guarantee has no executable spec, on the 4th definition of that SQL. Add a CI DB (pgTAP) job.
- **M-23 · `MEDIUM`** — queue retries have no backoff (`worker.ts:68`); a few-second vendor outage burns all 10 retries into the DLQ in seconds. Add per-message `delaySeconds` (exponential). https://developers.cloudflare.com/queues/configuration/batching-retries/
- **M-24 · `MEDIUM`** — the OpenNext incremental-cache layer is inert (read-only static-assets cache while the app uses `unstable_cache`+`revalidateTag`): every `set()` no-ops with error-log noise at 100% sampling, every read misses to Supabase, every revalidate is a no-op. Adopt R2/KV+D1 cache or remove the scaffolding. https://opennext.js.org/cloudflare/caching
- **M-27 · `MEDIUM`** — no Resend `Idempotency-Key` on any send, despite retry-on-failure designs that release a once-only claim and can double-send. Add `Idempotency-Key: <event>/<entity-id>`. https://resend.com/docs/dashboard/emails/idempotency-keys
- **M-8/M-9 · `MEDIUM`** — the in-memory rate limiters are **per-isolate on Workers** and provide no global throttle (`checkout-rate-limit.ts:14`). **M-8:** newsletter/interest are unauthenticated arbitrary-recipient email senders whose only guard is that limiter → **mail-bomb a victim + burn Resend quota + damage sender reputation** (degrading order-confirmation deliverability). **M-9:** `reserve_pieces` runs before the PI, so an attacker reserves the whole ~125-piece catalogue and re-reserves every 15 min → shop effectively closed, no money moved. The "durable WAF rule" the code defers to covers only `POST /api/checkout` (Free plan = one rule). Use the native Workers rate-limit binding. https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- **L-1, L-8, L-14, L-15, L-18, L-21, L-32…L-40** (`LOW`) — `validateCart` does per-item DB reads up to ~1028 before size guards (DB amplification); residual lock-ordering deadlock window; `webhook_events` unbounded growth with PII in `raw_json`; **the entire webhook_events ledger + queue pipeline has never run in prod (L-15)**; leaked-password protection off (moot while OAuth-only); InPost webhook token compared non-timing-safe + status mirrored with no monotonic guard (out-of-order events regress `/konto` status); merchant feeds rebuild the full catalogue per anonymous GET (no cache); API routes carry no security headers + CSP still report-only; newsletter confirm can be auto-confirmed by mail-scanner prefetch; `debug/fulfilment-status` safe only by the convention of never setting its token in prod; ceramic EUR/GBP checkout price comes from per-category constants not the DB columns (verify display-vs-charge parity).

---

## 6. Incomplete / Partially-Implemented Features

| # | Feature | What works | What's missing | Impact | Recommended close-out |
|---|---|---|---|---|---|
| 1 | **Global (WAF) rate limiting** | One WAF rule on `POST /api/checkout`; per-isolate limiters on returns/newsletter/confirm/interest | The cross-isolate durable control the comments defer to — absent for newsletter/confirm/interest (Free plan = 1 rule) | Abuse vectors M-8/M-9 unthrottled | Native Workers rate-limit binding or Turnstile |
| 2 | **Refund lifecycle (webhook leg)** | `releaseSale` 3-way CAS + crash-resume; admin inline Prodigi cancel; lost-dispute path live | `charge.refunded` unsubscribed → the whole leg is unreachable (C-1) | Refunds un-reconciled in prod | Subscribe the event (C-1) |
| 3 | **webhook_events ledger + Prodigi queue pipeline in prod** | Schema, dedup, both writers, consumer, DLQ, sweep, ~70 tests, sandbox smoke | **Zero production executions** (all 0 rows); destructive queue E2E never run — the only mode exercising the real queue + the C-2 bug | First real (esp. print) sale is the maiden run, on a paying customer | One controlled prod rehearsal (§15) |
| 4 | **Quantity stock reservation** (`track_inventory`/`stock_quantity`/`allow_backorder`) | Columns seeded; cosmetically read by admin | Reservation never reads them; `reserve_pieces` runs solely on `piece_state`; prints bypass reservation ("Stage 6") | Print inventory is effectively unlimited-by-design | Wire when print inventory limits are needed |
| 5 | **Per-product EUR/GBP + sale prices** (`price_eur/gbp`, `sale_price_*`) | Columns seeded | Storefront derives EUR/GBP per-*category*; per-product overrides + sale prices never read (Stage 4c) | Admin edits to these columns silently ignored (L-40) | Wire or remove the columns |
| 6 | **`products.slug` pretty URLs** | Column, unique constraint, admin editing + validation | Routing still resolves by id; no slug routing/301s | Dead admin capability | Build slug routing or hide the field |
| 7 | **`pod_variants` as a consumed catalogue** | Seeded/reconciled by `sync-prodigi-skus` | Nothing reads it at runtime; `PRODIGI_SKU_MAP` in code is the source of truth | Redundant maintenance | Consume it or document it as verification-only |
| 8 | **Worker-scope Sentry** | Init for Next request contexts; `captureMessage` calls for DLQ/failed-action | No init in the worker's own queue/scheduled contexts (M-16) | Alerts may no-op | Init at worker entry |
| 9 | **CSP enforce + API security headers** | Report-only CSP with dual reporting; bounded sink | The enforcing header; `/api` + admin carry no headers (L-33) | No CSP protection today | Set headers in `worker.ts`; schedule enforce cutover |
| 10 | **Workers traces** | Logs on; traces configured (`persist`, sampling) | `enabled:false` — half-wired | No distributed tracing | Enable or remove |
| 11 | **`in_production` fulfilment stage** | Mapping exists | Prodigi v4 likely never emits it → orders jump submitted→shipped | Missing intermediate state | Confirm the stage enum from callbacks |
| 12 | **Newsletter human-confirmation** | Full stateless double opt-in | Button-POST landing to stop scanner auto-confirms (L-38) | Consent-quality hole | Ship when Resend timestamps cluster |
| 13 | **Abandoned-cart recovery** | `cart.checkout_started` fired; `cart.purchased` cancels it | (per prior memory) automation disabled pending consent | Recovery emails not sent | Product decision |

---

## 7. Stripe Audit

**Version posture `[CONFIRMED-LIVE]`:** `stripe` `^22.2.0` (bundled API `2026-05-27.dahlia`, verified in `node_modules/stripe/cjs/apiVersion.js:5`); the live endpoint's API version matches. `src/lib/stripe.ts` does not pin `apiVersion`, but — contrary to the AGENTS.md "API-version ritual" — **stripe-node v22 pins the bundled version on every request** (M-28); the account-default behavior was true only for `<v12`. `npm update stripe` therefore silently moves all requests.

**What's correct `[CONFIRMED-CODE/LIVE]`:** signature verification via `constructEventAsync` on the raw body (WebCrypto); a real `webhook_events` at-least-once idempotency ledger with leased-CAS + release-on-throw; idempotency keys on `paymentIntents.create` (`pi_create_<orderId>`) and `refunds.create` (`refund_<pi>`); correct minor-unit conversion (grosze/euro-cents/pence); PMC via a runtime secret with fail-closed `502`; the deliberate `payment_intent.payment_failed` no-op (correct per the PI lifecycle); reserve-before-PI ordering; best-effort PI cancel on persist failure; conversions claimed synchronously then `waitUntil`-deferred with an 8 s timeout. Server-side amount/currency computation makes **checkout amount tampering impossible** (client never sends a price).

**Gaps:** C-1 (missing `charge.refunded` subscription — the headline), H-3 (legacy refund model + unhandled `refund.failed`), M-20 (heavy sync work before 2xx), M-21/M-22 (idempotency-ledger error-swallow + in-flight-lease drop windows), M-28 (API-version model), L-6 (5 unhandled subscribed events + no `charge.dispute.created` alert). One benign live anomaly: `webhook_events = 0` rows is explained by the last order (2026-07-22) predating the ledger migration (2026-07-28) — **not** a broken insert, but it means the ledger has never actually run (L-15).

**Sources:** https://docs.stripe.com/refunds#refund-events · https://docs.stripe.com/refunds#failed-refunds · https://docs.stripe.com/webhooks · https://docs.stripe.com/webhooks#verify-official-libraries · https://docs.stripe.com/webhooks/process-undelivered-events · https://docs.stripe.com/api/idempotent_requests · https://docs.stripe.com/currencies#zero-decimal · https://docs.stripe.com/payments/payment-method-configurations · https://docs.stripe.com/payments/paymentintents/lifecycle · https://docs.stripe.com/disputes/how-disputes-work · https://docs.stripe.com/sdks/set-version

---

## 8. Supabase Audit

**Posture `[CONFIRMED-LIVE]`:** Postgres 17; **47 local migrations exactly match 47 applied in prod** (no table/function drift); RLS enabled on every table; all server access uses the service-role key with `persistSession:false` and no browser client; **no Edge Functions**. Row counts sane (products 172, product_variants 1112, piece_state 126, orders 42, order_items 115).

**What's correct `[CONFIRMED-CODE]`:** RLS deny-all + service-role-only reads; **zero `SECURITY DEFINER` functions**, and every function pins `search_path = public, pg_temp`; `reserve_pieces`/`reserve_private_sale_pieces` provably prevent concurrent double-reservation (sorted `FOR UPDATE` deadlock-avoidance + conflict predicate under held locks + same-txn UPDATE) — verified by reading the hardening migration; `publish_cms_version` is idempotent; `link_orders_to_user` is a model hardened RPC (revokes PUBLIC, respects `user_unlinked_at`, scopes to `paid`/`refunded`); account reads filter by the jose-verified JWT `user_id` and exclude the marketing column — **no IDOR on `/konto/zamowienia/[id]`** (verified: uniform 404 on unknown/foreign/unsettled). Customer-auth JWT verification (jose vs `/auth/v1/.well-known/jwks.json`, issuer + audience pinned) is sound and fail-closed.

**Gaps:** M-2 (four RPCs retain `PUBLIC EXECUTE`), M-3 (out-of-band anon `piece_state` policies + duplicate pair — schema drift), M-4 (0 zł fail-open price), M-25 (`[UNVERIFIED]` legacy key format), L-9/L-10/L-11/L-12/L-13/L-17 (audit-outside-txn, unvalidated TTL, phantom-INSERT window, unindexed FKs, missing CHECK constraints, intentional FK gaps). Advisor `[CONFIRMED-LIVE]`: 19× `rls_enabled_no_policy` (INFO, intentional deny-all), `multiple_permissive_policies` on `piece_state` (M-3), leaked-password protection off (L-18, moot while OAuth-only), 2 unindexed FKs + several unused indexes (L-12).

**Sources:** https://supabase.com/docs/guides/database/hardening-data-api · https://supabase.com/docs/guides/database/database-advisors?lint=0006_multiple_permissive_policies · https://supabase.com/docs/guides/database/database-advisors?lint=0008_rls_enabled_no_policy · https://supabase.com/docs/guides/database/database-advisors?lint=0011_function_search_path_mutable · https://supabase.com/docs/guides/api/api-keys · https://supabase.com/docs/guides/auth/password-security · https://supabase.com/docs/guides/auth/signing-keys

---

## 9. Other Integrations

### Cloudflare Workers / OpenNext / Queues / R2 / cron
Correct `[CONFIRMED-CODE]`: the custom-worker pattern with the required DO re-exports; explicit ack/retry with a pure disposition helper; DLQ alert-only ack-before-email (no poison loop); `ctx.waitUntil` discipline within budget + 8 s timeouts; no global mutable state; HMAC-signed R2 URLs (a sound alternative to S3 presign); `middleware.ts` kept (not `proxy.ts`) per Next 16. **Gaps:** **C-2** (queue context — the big one), M-16 (worker-context Sentry), M-23 (no retry backoff), M-24 (inert incremental cache), M-15 (cron alerting/status). Note: R3 research observes that `@opennextjs/cloudflare` added Turbopack support upstream (v1.15.0+), so the "OpenNext cannot load Turbopack chunks" rationale is stale as an *absolute* — **but the webpack pin remains a correct policy choice and must not be changed** (it is a project non-negotiable). **Sources:** https://opennext.js.org/cloudflare/howtos/custom-worker · https://developers.cloudflare.com/queues/configuration/batching-retries/ · https://opennext.js.org/cloudflare/caching · https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ · https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ · https://docs.sentry.io/platforms/javascript/guides/cloudflare/

### Prodigi (Print API v4)
Correct: the callback **re-fetches order state from Prodigi and never trusts the payload** (forging fulfilment completion is not possible), leased-CAS dedup, env-namespaced idempotency key, https-only tracking URLs. **Gaps:** C-2 (queue can't submit), M-11 (no timeout), M-12 (no reconciliation for a lost callback), M-14 (bearer URL TTL + persisted), M-26 (`outcome` unchecked), L-19/L-22 (env-flip key collision, unexercised contract assumptions). **Entire pipeline is unrun in prod (L-15).** Source: https://www.prodigi.com/print-api/docs/reference/

### InPost ShipX
Ceramic shipping + returns work; the webhook is authenticated by a shared `?token=` query secret. **Gaps:** L-34 (non-timing-safe `!==` compare — the only non-constant-time webhook), L-35 (status mirrored with no allow-list or monotonic guard → out-of-order events regress `/konto`), M-13 (token in URL, persisted in 100%-sampled logs; source-IP allowlist `91.216.25.0/24` unused). Sources: https://developers.inpost-group.com/webhook-signature-verification · https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/pages/18153494/Webhooks

### Resend
Correct: **Svix signature verification is spec-exact** (base64 key, `${id}.${ts}.${body}`, 300 s tolerance, raw body before parse, fail-closed 500, 64 KB caps); global `/contacts` endpoint with 409 idempotency; double-opt-in HMAC token constant-time. **Gaps:** M-27 (no `Idempotency-Key` on sends), L-38 (scanner auto-confirm). Source: https://resend.com/docs/dashboard/emails/idempotency-keys

---

## 10. Data Integrity & Failure Modes

- **Inventory / oversell:** the core guarantee is **sound** — `reserve_pieces` prevents concurrent double-reservation, and no code path sells a piece without payment (`piece_state` flips `reserved→sold` only in `markPaid` on `payment_intent.succeeded`). Residual windows: M-4 (0 zł fail-open), M-5 (private-sale double-payment loop), H-1 (asymmetric-failure auto-refund leaving pieces stuck `reserved`), L-8 (benign deadlock window), L-35 (status regression). The oversell guarantee has **no executable test** (M-19).
- **Refund convergence:** **broken in prod (C-1)** — refunded pieces never relist, orders never converge. The convergence *code* is otherwise a careful 3-way CAS with crash-resume.
- **Idempotency / duplicate processing:** generally strong (leased-CAS ledger, claim-once emails/conversions, idempotent Stripe keys). Weak spots: M-21 (seen-SELECT error-swallow → false dedup 200), M-22 (in-flight-lease drop), L-4 (release not CAS-scoped).
- **Atomicity boundaries:** RPCs are transactional and correct; app-side multi-step writes (webhook, callback) rely on CAS + retry rather than DB transactions, which is appropriate for the stateless-Worker model but leaves the narrow windows above.
- **Print fulfilment:** currently **cannot complete (C-2)**; once fixed, M-10/M-12/M-26 are the remaining silent-failure modes.

---

## 11. Security Review

- **AuthN/Z:** customer sessions (jose vs Supabase JWKS, issuer+audience pinned, httpOnly+Secure+SameSite=Lax cookies, fail-closed) and the admin gate (real `jwtVerify` vs CF Access JWKS, not a decode) are both **correctly implemented**. No IDOR on account order history (verified). Residuals: M-6 (allowlist fail-open — LOW, defense-in-depth), M-7 (no admin CSRF/Origin), M-1 (latent link-orders — LOW), L-26 (unpinned JWT alg), L-27/L-29/L-30.
- **Auth bypass (H-2):** **refuted** — the raw-pathname gate is a latent fragility, not an active bypass, because Next/OpenNext dispatch admin routes by exact string match.
- **Input validation / client trust:** strong — checkout recomputes all money server-side; `validateCart`/`validateDelivery`/`validatePrintDelivery` narrow all inputs; private-sale token is high-entropy with uniform 404. Residual: M-4 (0 zł), L-1 (cart-size amplification).
- **Webhook verification & replay:** Stripe (signature + ledger) and Resend (Svix) are spec-correct; Prodigi is token-gated + re-fetches state (forgery-resistant); InPost is a shared-secret token (L-34 non-constant-time; M-13 token-in-URL). Replay is handled by the shared `webhook_events` ledger for Stripe/Prodigi; InPost lacks dedup but is idempotent via claim slots (except status regression L-35).
- **Secrets:** never exposed to the client; fail-closed gating throughout (PMC, newsletter, CMS preview, debug endpoint, auth feature flag). Residuals: M-13 (webhook secrets in URLs + logs), M-17 (`.env.example` gaps), L-23 (no rotation story), L-30 (`ADMIN_*` overrides).
- **Rate limiting:** the weakest area — per-isolate in-memory limiters give no global throttle (M-8 mail-bomb, M-9 reservation griefing); only `POST /api/checkout` has a real WAF rule.
- **CORS / headers:** webhook routes are POST-only with no CORS; but `/api` + admin responses carry **no security headers** and CSP is report-only (L-33).
- **Storage:** print-asset signing is correct (constant-time HMAC, immutability-frozen fields); R2 bucket public-access posture is `[UNVERIFIED]` (L-25).

---

## 12. Testing & Observability Gaps

**Tests that exist:** ~70 Stripe-webhook route tests, `conversions.test.ts`, checkout route tests, pgTAP suites for private-sale / guarded-status / print-assets / fulfilment-idempotency, Prodigi sandbox contract-smoke, and a (never-run) destructive purchase E2E.

**Critical flows with NO / insufficient test:**
- **`reserve_pieces` SQL itself** (M-19) — the oversell guarantee; every test mocks the RPC. On its 4th definition with no regression net.
- **`worker.ts`** entirely (M-18) — including `cancelIntent`'s status mapping (the cron's only oversell guard), the abandoned-expiry CAS, the DLQ handler, the admin actor-header strip.
- **The queue→Prodigi path at runtime** (C-2, L-15) — masked by the inline-dev path + a mocked `getSupabaseAdmin`; the real queue context (which throws) is never exercised.
- **Refund/dispute convergence end-to-end** — the code is tested in isolation but the missing subscription (C-1) was invisible to tests because tests don't assert the live endpoint's `enabled_events`.

**Observability gaps:** M-15 (cron paid-on-pending is console-only; dead sweeps show green), M-16 (worker-context Sentry may no-op — undercuts every queue/DLQ alert), L-21 (queue retry error swallowed for the full 10-delivery lifetime), L-14 (no `webhook_events` retention/index). **Net:** several of the most important failure modes (a missed `succeeded`, a dead-lettered print job) depend on alert channels that are themselves unverified or misconfigured.

---

## 13. Feature Development Opportunities

Each is grounded in the current system and existing building blocks (not a generic platform feature).

1. **Webhook-config drift guard `[Opp-2]`** — a CI/`orders`-CLI smoke that fetches the Stripe endpoint and asserts `enabled_events ⊇ handled-set` and `endpoint API version == SDK bundled version`. *Would have caught C-1 and prevents M-28 drift.* Building blocks: `orders-cli` already loads Stripe from env; handled set is a static list in `webhook.ts`. Value: high. Complexity: S.
2. **Refund reconciliation sweep `[Opp-3]`** — extend `reconcile-orders.mjs` to list Stripe refunds with `amount_refunded==amount` for orders still `paid` and drive them through an extracted `releaseSale` (or at least alert). Makes refund convergence survive config drift / dropped deliveries. Complexity: M.
3. **Queue-context lint/test guard `[Opp-6]`** — ESLint `no-restricted-imports` forbidding `getCloudflareContext`-dependent imports under `src/server/fulfilment/**`, mirroring `scripts/build-config.test.ts`. *Prevents C-2 regression.* Complexity: S.
4. **Native Workers rate-limit binding `[Opp-1]`** — replace the per-isolate `allow()` limiters with the platform binding (supports the 60 s window) or Turnstile. Turns M-8/M-9 into enforced controls without a Pro-plan upgrade. Complexity: S–M.
5. **Cron-driven Prodigi reconciliation `[Opp-4]`** — poll non-terminal `prodigi_orders` + stale `fulfilment_jobs`, re-run the callback merge, optionally re-enqueue. Converts M-10/M-12 silent-failure modes into self-healing; `scheduled()` already runs idempotent sweeps. Complexity: M.
6. **Print-order reconcile mode in `reconcile:orders`** — re-enqueue/resubmit with the same idempotency key; turns every DLQ/failed-action email's manual-recovery instruction into one command. Complexity: S/M.
7. **RPC surface hardening migration** — revoke PUBLIC/anon/authenticated EXECUTE on the four legacy RPCs, bound `p_ttl_secs`, codify-or-drop the out-of-band `piece_state` policies (M-2/M-3/L-10). Complexity: S.
8. **pgTAP / CI DB test for `reserve_pieces`** (M-19) — `supabase start` in CI applying all migrations + asserting the concurrent-reserve / expired-takeover / showroom / private-sale matrix. Complexity: M.
9. **Authenticated-user RLS policies on `orders`/`order_items`** as defense-in-depth behind the account reads (`using (user_id = auth.uid() and status in ('paid','refunded'))`) — costs nothing (reads stay service-role) but makes a future filter regression fail closed. Complexity: S.
10. **Alert on `charge.dispute.created`** — the event is already delivered + signature-verified; only a handler branch is missing (L-6). Recovers the dispute-response deadline. Complexity: S.
11. **Retention/pruning cron** for `webhook_events`/`cms_audit_log`/`catalog_audit_log` (L-14) — the worker already has a 15-min cron. Complexity: S.
12. **Env-var completeness test** (M-17) + **`cancelIntent` mapping extraction & matrix test** (M-18). Complexity: S.
13. **Cache the merchant feeds** (`s-maxage`/`unstable_cache` keyed on locale with the `inventory` tag) — L-32. Complexity: S.
14. **Set the security-header block in `worker.ts`** so `/api` + dotted paths inherit them, plus schedule the CSP enforce cutover (L-33). Complexity: S–M.
15. **Shorten signed-URL TTL + redact asset URLs from persisted Prodigi JSON** (M-14) — `redactSignedPrintAssetUrl` already exists. Complexity: S.

*(Full 23-item list, incl. key-versioned HMAC rotation, single-source status vocabularies, composite `orders(status,created_at)` index, Resend `svix-id` dedup, and per-market price parity review, is in the master ledger §C.)*

---

## 14. Prioritized Action Plan

**Do not implement before acceptance.** Ordered by impact × likelihood, not by technology.

### P0 — immediate (money/data integrity; do before the next refund and before the first print sale)
- **C-1** — subscribe `charge.refunded` (config) + one-time backfill of order `8be30881`/piece `s15`; add the drift guard (Opp-2) and refund reconciliation (Opp-3).
- **C-2** — inject `supabaseFromEnv(env)` into `processJob`; add the queue-context lint guard (Opp-6); run a controlled queue rehearsal in a preview **before enabling/first print sale**.
- **M-16** — initialize Sentry in the worker's queue/scheduled contexts (otherwise C-2's and every DLQ alert may be silent). Confirm `RESEND_API_KEY`/`STUDIO_NOTIFY_EMAIL` are set in prod.

### P1 — high priority (integrity/reliability/security hardening)
- **H-1** (destructure + throw the reserved→sold UPDATE error), **H-3** (modern refund events + `refund.failed`), **H-4** (root-cause the admin-editor Sentry error).
- **M-2/M-3** (RPC EXECUTE + out-of-band `piece_state` policies), **M-4** (0 zł fail-open), **M-5** (private-sale double-pay loop), **M-15** (cron paid-on-pending alerting), **M-17** (`.env.example` gaps → DR checkout 502), **M-10** (widen the stranded-job sweep).

### P2 — medium priority
- **M-7** (admin CSRF/Origin), **M-8/M-9** (native rate-limit binding), **M-11/M-12/M-26** (Prodigi timeout/reconciliation/`outcome`), **M-13** (webhook secrets in URLs/logs), **M-14** (signed-URL TTL + redaction), **M-18/M-19** (worker + reserve-SQL tests), **M-20/M-21/M-22** (webhook ack-fast + ledger error handling), **M-23/M-24/M-27/M-28**.

### P3 — optimizations / cleanup / growth
- The `L-*` set (data hygiene, headers, feed caching, key rotation, status validation), the incomplete-feature close-outs (§6), and the remaining opportunities (§13). **Do not** switch the build system despite the stale-rationale note (L-note/R3).

---

## 15. Verification Gaps

Items that could not be confirmed read-only, and the exact test to settle each:

1. **Stripe v2 Event Destinations** — the connector exposes only legacy webhook endpoints; a v2 destination *could* (unlikely) subscribe `charge.refunded`. **Test:** in the Stripe Dashboard → Developers → Event destinations (or `GET /v2/core/event_destinations`), confirm no destination re-adds the event. *(C-1's live-DB proof already shows reconciliation is not happening regardless.)*
2. **C-2 runtime throw** — verified from code + OpenNext internals but never observed in prod (0 queue deliveries). **Test:** `npm run preview:cf` (binds `FULFILMENT_QUEUE`, runs the real queue path), push one `FulfilmentJobMessage`, `wrangler tail` → expect the `getCloudflareContextSync` throw on every delivery + 10 retries → DLQ. Then `SELECT status, count(*) FROM fulfilment_jobs GROUP BY 1`.
3. **H-2 admin-gate variants** — refuted by source analysis; confirm empirically. **Test (preview only, never prod):** `curl -is -X GET https://<preview>/api/%61dmin/refund` and `…/api/admin%2frefund` → expect `404` (handler not reached); a `405`/JSON error would indicate the handler *was* reached (would re-open it).
4. **H-4 admin-editor error** — open the exact Sentry event; read the request host + whether `SUPABASE_URL` is bound in that deployment (preview vs prod).
5. **M-6 exploitability** — depends on the Cloudflare Access **application policy** (dashboard state). **Test:** review the Access app's policies for `anna-ciok.studio/admin*`; `wrangler secret list` to confirm whether `ADMIN_ALLOWED_EMAILS` is set in prod.
6. **M-25 Supabase key format** — legacy JWT vs `sb_secret_`/`sb_publishable_`. **Test:** inspect the key prefixes in the Supabase dashboard / prod secrets.
7. **L-25 R2 bucket posture** — `wrangler r2 bucket info anna-ciok-print-assets` to confirm no public `r2.dev`/custom-domain access and that the operator S3 token is scoped to this bucket.
8. **Whole print/queue/ledger pipeline** — has never run in prod (L-15). **Test:** one end-to-end rehearsal (test-mode Stripe order through webhook→ledger; destructive E2E against a preview with `PRODIGI_ENV=sandbox`), then inspect the resulting rows + every alert channel.
9. **Secret values in prod** — `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`, `RESEND_API_KEY`, `STUDIO_NOTIFY_EMAIL`, `NEWSLETTER_CONFIRM_SECRET`, etc. — presence not readable read-only; `wrangler secret list` confirms names.

---

## 16. Sources

Official documentation consulted during this audit (version-matched to the repo's dependencies where relevant):

**Stripe** — refund events https://docs.stripe.com/refunds#refund-events · failed refunds https://docs.stripe.com/refunds#failed-refunds · webhooks https://docs.stripe.com/webhooks · verify signatures https://docs.stripe.com/webhooks#verify-official-libraries · undelivered events https://docs.stripe.com/webhooks/process-undelivered-events · idempotent requests https://docs.stripe.com/api/idempotent_requests · zero-decimal currencies https://docs.stripe.com/currencies#zero-decimal · payment method configurations https://docs.stripe.com/payments/payment-method-configurations · PI lifecycle https://docs.stripe.com/payments/paymentintents/lifecycle · disputes https://docs.stripe.com/disputes/how-disputes-work · SDK set version https://docs.stripe.com/sdks/set-version

**Supabase** — data API hardening https://supabase.com/docs/guides/database/hardening-data-api · advisor 0006 https://supabase.com/docs/guides/database/database-advisors?lint=0006_multiple_permissive_policies · advisor 0008 https://supabase.com/docs/guides/database/database-advisors?lint=0008_rls_enabled_no_policy · advisor 0011 https://supabase.com/docs/guides/database/database-advisors?lint=0011_function_search_path_mutable · API keys https://supabase.com/docs/guides/api/api-keys · password security https://supabase.com/docs/guides/auth/password-security · signing keys https://supabase.com/docs/guides/auth/signing-keys

**Cloudflare / OpenNext / Sentry** — custom worker https://opennext.js.org/cloudflare/howtos/custom-worker · caching https://opennext.js.org/cloudflare/caching · queues batching & retries https://developers.cloudflare.com/queues/configuration/batching-retries/ · scheduled handler https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ · rate-limit binding https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ · Sentry Cloudflare https://docs.sentry.io/platforms/javascript/guides/cloudflare/ · OpenNext Turbopack note https://github.com/opennextjs/docs/issues/209

**Integrations** — Prodigi Print API https://www.prodigi.com/print-api/docs/reference/ · Resend email idempotency https://resend.com/docs/dashboard/emails/idempotency-keys · Resend webhook verification https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests · InPost webhooks https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/pages/18153494/Webhooks · InPost webhook signatures https://developers.inpost-group.com/webhook-signature-verification

---

*Prepared read-only. The only repository change is this report file. No remediation has been started; awaiting acceptance of the findings before any system change.*
