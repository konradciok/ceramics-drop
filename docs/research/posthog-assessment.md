# PostHog: platform-fit assessment for anna-ciok.studio

**Date:** 2026-08-03 · **Status:** research / decision input, nothing implemented
**Question asked:** does PostHog earn a place in this stack, given Sentry already covers part of it, and without duplicating what we run today?

---

## Verdict

**Do not adopt PostHog as an analytics, error-tracking, or session-replay platform.** All three are already owned by incumbents that are more deeply wired into this codebase than a swap could justify.

**There is a narrow, real case for PostHog as a feature-flag + survey layer**, which this project has *zero* coverage of today. That case is genuine but small, and it is gated behind non-trivial compliance and CSP work. See [Recommendation](#recommendation) for the staged call.

**On the reporting gaps (§3), the two gaps resolve differently:**

- The burned `order_total` custom dimension is fixed by **linking the GA4 BigQuery export alone** — free, already scripted (`npm run bq:query`), flagged as outstanding at `docs/analytics-stack.md:105`. PostHog adds nothing here.
- The order↔behaviour join needs **both** sides in one place, and the BigQuery link only delivers the behaviour side. `scripts/bq-query.mjs` queries GA4 event tables only; **no Supabase→BigQuery path exists in this repo**, so completing the join means either building that pipeline or using PostHog's managed Supabase connector as the second source. That connector — sparing you an ETL you'd otherwise write and operate — is the one narrow, concrete thing PostHog contributes to §3.

---

## 1. What the stack already covers

Established by reading the code, not the docs.

| Capability | Owner today | Depth of integration |
| --- | --- | --- |
| Exception tracking (browser / node / edge) | **Sentry** `@sentry/nextjs ^10.56.0` | 86 explicit `captureException`/`captureMessage` call sites across 23 files, plus `onRequestError` (`src/instrumentation.ts`) and `worker.ts` alert forwarding |
| Release correlation + source maps | **Sentry** | `release` = `package.json` version, inlined at build (`next.config.ts`), matched to uploaded source maps |
| PII scrubbing on errors | **Sentry**, custom | `scrubSentryEvent` (`src/lib/sentry-options.ts`) strips cookies, `Authorization`, `X-Forwarded-For`, the entire query string (capability tokens), and truncates `extra` |
| Ad-blocker-resistant transport | **Sentry** | `tunnelRoute: '/sentry-tunnel'` (`next.config.ts`) |
| Performance tracing | **Sentry** | `tracesSampleRate: 0.1` in prod |
| Product + ecommerce analytics | **GA4 via GTM** | Full GA4 ecommerce contract, 17 registered custom dimensions, container `GTM-NPHLG9NR` v17, exports committed to `docs/` |
| Server-side conversions | **Meta CAPI + GA4 MP** | `src/lib/marketing/`, deterministic `purchase-<pi>` event_id dedup with the browser, claimed once per order via `orders.conversions_sent_at`, dispatched through `ctx.waitUntil` |
| Session replay + heatmaps | **Microsoft Clarity** | Loaded via GTM, consent-gated on `analytics_storage` |
| Consent management | **Google Consent Mode v2** | `src/components/consent/`, binary `ciok_consent` cookie driving all four Google signals |
| Product feeds | GA4/Meta catalog | `/api/feed/google`, `/api/feed/meta` |

### What has **no** owner today

| Capability | Current substitute | Pain |
| --- | --- | --- |
| **Feature flags** | Redeploy. Env-var presence (`SUPABASE_PUBLISHABLE_KEY` as the accounts kill switch), code constants (`HIDDEN_CATEGORIES`, `DROP_OVERRIDE`, `CATALOG_SOURCE`), or a CMS publish | Every toggle is a build + deploy, or a GTM publish |
| **A/B tests / experiments** | None | No way to test PDP copy, pricing presentation, or checkout layout |
| **Surveys / voice-of-customer** | `ShowroomInterestForm`, `ContactForm` — both one-way | No post-purchase NPS, no exit-intent "why didn't you buy" |
| **Event-level SQL over behaviour + orders** | GA4 Explorations only | BigQuery export never linked; `npm run bq:query` fails its own dataset check |

---

## 2. Overlap matrix — PostHog product by product

| PostHog product | Overlaps with | Verdict |
| --- | --- | --- |
| Error tracking | **Sentry** — fully | ❌ **Skip.** 86 capture sites, custom scrubbing, source maps, worker alerting, a tunnel route. Migration is weeks of work to land in a *less* mature error product. PostHog's own docs tell you to disable one autocapture if you run both. |
| Session replay | **Microsoft Clarity** — fully | ❌ **Skip.** Clarity is free and unlimited; PostHog is free to 5k recordings then $0.005/recording. Running both doubles the replay-privacy surface on a checkout that handles addresses and payment fields. |
| Product analytics | **GA4** — substantially | ❌ **Skip as a replacement.** Removing GA4 costs the GA4 MP server purchase (`ga4-mp.ts`) and GA4 ecommerce reporting. It does **not** break Meta CAPI (`meta-capi.ts` imports nothing GA4) or the feeds (`feed.ts` builds from the product registry) — those are independent and survive. The real objection is transport: `analytics.ts` → dataLayer → GTM is the shared pipe that also drives the Meta Pixel tags, so it stays regardless. PostHog would be a *third* event contract on top, not a replacement for the second. |
| Web analytics | **GA4** | ❌ Skip. Pure duplication. |
| Heatmaps | **Clarity** | ❌ Skip. |
| **Feature flags** | **nothing** | ✅ **Genuine gap.** |
| **Experiments** | **nothing** | ⚠️ Genuine gap, but see the traffic caveat in §4. |
| **Surveys** | **nothing** | ✅ **Genuine gap**, cheapest possible win. |
| **Data warehouse / HogQL** | GA4 BigQuery export — *which was never linked* | ⚠️ **Partial.** The export alone fixes `order_total` (§3.1). For the order↔behaviour join (§3.2) PostHog's managed Supabase connector is a real contribution — no Supabase→BigQuery path exists here — but it is only useful *alongside* the export, never instead of it. |
| CDP / data pipelines | Resend, Meta CAPI, GA4 MP — all hand-rolled and working | ➖ Neutral. Would be a rewrite of working code. |
| LLM observability | n/a | ➖ Not applicable. |

---

## 3. Two real reporting gaps — and why BigQuery, not PostHog, is the fix

Both gaps below are genuine, and they resolve differently. **§3.1 (`order_total`) is fixed by the BigQuery export alone — PostHog adds nothing.** **§3.2 (the order↔behaviour join) needs the export *and* a Supabase-side connector**, and PostHog supplies that connector as a managed service where this repo has no Supabase→BigQuery path at all. Documented in full so the reasoning is on record rather than re-litigated later.

### 3.1 GA4's custom-dimension registry is a finite, burnable resource

From `docs/analytics-stack.md:81`:

> `order_total` could **not** be registered: GA4 returns `409 ALREADY_EXISTS` for it even though it is absent from the active list — an **archived** `order_total`/EVENT dimension still holds the `parameterName`+scope slot. The Admin API has no un-archive method […] the param name is effectively burned.

So `order_total` is collected on every `purchase` and `begin_checkout` and is **permanently unqueryable in GA4**. GA4 also caps event-scoped custom dimensions (the property is at 17), and registration is **non-retroactive** — a dimension registered today cannot see yesterday's data.

**This is a GA4 *UI/Data API* limitation, not a data-loss one.** `order_total` is still recorded on every event, and the GA4 **BigQuery export preserves it in `event_params`** with no registered custom dimension required. Linking the export therefore recovers `order_total` outright — that is the fix.

PostHog would also store every property as queryable data with no registration, cap, or retroactivity cliff — but only for events *sent to PostHog*. It cannot retroactively read GA4's history. PostHog's **native GA4 connector syncs daily aggregate report data only** (users, sessions, pageviews, traffic sources) — not raw events, so not `order_total`. Getting raw GA4 events into PostHog requires either the BigQuery export (connected to PostHog as a BigQuery *source*, i.e. strictly downstream of the fix) or ingesting events into PostHog directly from the app. Neither removes the BigQuery dependency.

### 3.2 The order/behaviour join is currently impossible

`orders`, `order_items`, and `piece_state` live in Supabase. Behavioural events live in GA4. There is no join. The GA4 BigQuery export — documented as an outstanding prerequisite (`docs/analytics-stack.md:105`), with `npm run bq:query` failing until it is done — is **half** the bridge, not the whole one.

The questions worth asking are inherently joins — *"which collection pages did buyers of `duze-michy` view first?"*, *"what's the view→sale lag for a piece by category?"*, *"do private-sale link recipients convert differently?"*

**PostHog only closes half of this join.** Its managed warehouse syncs Supabase Postgres directly, so `orders` / `order_items` / `piece_state` land cleanly — but that sync moves *orders, not behavioural events*. The other half of every question above is behavioural, and it only reaches PostHog if you either (a) adopt PostHog product analytics and send events there — which §2 recommends against — or (b) connect the GA4 BigQuery export as a source, which requires linking the export first.

**And the BigQuery link alone does not close it either.** `scripts/bq-query.mjs` queries GA4 event tables only, and nothing in this repo syncs Supabase into BigQuery — so the export delivers the behaviour side and leaves the order side stranded. Completing the join needs one of:

| Route | Behaviour side | Order side | Cost |
| --- | --- | --- | --- |
| **BigQuery only** | GA4 export ✅ | Build + operate a Supabase→BQ pipeline ❌ (does not exist) | Engineering time, ongoing |
| **BigQuery + PostHog** | GA4 export, connected to PostHog as a BigQuery source | PostHog's managed Supabase connector ✅ | $0 on the free tier |
| **PostHog only** | Requires adopting PostHog analytics — §2 recommends against | Managed Supabase connector ✅ | Duplicated event contract |

**This is the one place PostHog earns its keep in §3:** it supplies the Supabase-side connector as a managed service, so you get the join without writing and maintaining an ETL. That is a genuine saving — narrower than "PostHog unifies your data," but real.

**Managed does not mean frictionless.** That connector carries real operational and privacy constraints — alpha CDC, a direct-connection requirement, a WAL-retention failure mode that lands on the production database, and personal data leaving for a new processor. They are set out under Stage 1 in the [Recommendation](#recommendation) and should be read before treating this row as a cheap win.

**Second caveat:** either way this is *analyst* value, not *engineering* value. It pays off only if someone actually writes the queries. If nobody will, neither option is worth doing.

---

## 4. Where the feature-flag and experiment case gets weaker than it looks

Being straight about this, because it's the part that sounds most compelling and holds up least.

**Flags.** The toggles this codebase actually has are *ops kill switches*, not product flags: `SUPABASE_PUBLISHABLE_KEY` presence, `HIDDEN_CATEGORIES`, `CATALOG_SOURCE`, `DROP_OVERRIDE`, `FULFILMENT_DEBUG_TOKEN`. These are fail-closed by design and are correctly env-vars — you *want* flipping the accounts kill switch to be a deliberate, audited deploy, not a dashboard click by anyone with PostHog access. The flags that would genuinely benefit from runtime control are product-surface ones that don't exist yet (new PDP layout, configurator variants, checkout copy).

**Experiments.** This is a single-artisan storefront selling ~125 one-of-a-kind pieces. A/B testing needs traffic volume to reach significance, and each ceramic piece is a sample size of one — you cannot A/B test a product that sells once and is gone forever. Experiments would only be meaningful on **fine-art prints** (genuinely repeatable inventory, POD-fulfilled, unlimited supply) and on **sitewide surfaces** (homepage hero, `/sklep` hub, checkout). That's a much narrower surface than "we could A/B test the store."

**Surveys** hold up best. Post-purchase ("how did you find us?" — closes the attribution gap Consent-Mode-denied visitors leave), exit-intent on `/koszyk`, and a `sold_item_view` follow-up on the drop-demand signal. Free to 1,500 responses/month, no infrastructure, no schema.

---

## 5. Integration cost — the constraints specific to this project

These are the things that would make a PostHog adoption more expensive here than the marketing page suggests.

### 5.1 Consent is binary and Google-shaped

`src/components/consent/consent-mode.ts` sets one cookie, `ciok_consent`, with one value (`granted`/`denied`), which drives all four Google Consent Mode v2 signals at once. Every tag today is gated by **GTM**, not by app code.

PostHog is not in GTM's consent framework. Loading `posthog-js` in `instrumentation-client.ts` bypasses the entire consent architecture.

**The recommended path is explicit opt-in, and only that:** initialise with **`opt_out_capturing_by_default: true`**, then map `setConsent()` one-to-one — `granted` → `posthog.opt_in_capturing()`, `denied` → `posthog.opt_out_capturing()`. This matches the app's existing binary model and the "denied means nothing is sent" behaviour GTM already enforces.

**`cookieless_mode: 'on_reject'` is *not* an equivalent alternative** and should not be treated as one. It keeps capturing anonymous, server-hashed events *after* a visitor has rejected — a different tracking policy, not a different implementation of the same one. It also requires the Cookieless server hash mode setting enabled project-side or events are silently discarded on ingestion, and it forbids `identify()`. If it is ever considered, it needs an explicit legal/product decision about the lawful basis for capturing post-rejection in PL/EU, not a config-level judgement call.

**`persistence: 'memory'` is not a consent mechanism** and must not be used as one: it only changes *where* the SDK stores identity, not *whether* it captures, so events would still be sent before the visitor has accepted. Either way this is a new, hand-maintained consent path parallel to the GTM one, for a PL/EU store where this is a live GDPR obligation, not a nicety.

### 5.2 CSP is mid-migration and PostHog widens it

`src/middleware.ts:70` runs `Content-Security-Policy-Report-Only`, explicitly staged to be **tightened and enforced** (Plan 5, group G5). PostHog requires `https://*.posthog.com` in `script-src` (SDK + lazily-loaded replay/survey bundles), `connect-src` (ingestion + flag evaluation), and `worker-src 'self' blob: data:` — `data:` included, or worker-backed features (session replay especially) fail silently once the policy is enforced.

Adding a wildcard third-party origin to a policy you are about to enforce, at the same time you're enforcing it, is the wrong order of operations. Either do it after the enforce cutover, or route everything first-party through a reverse proxy — which this project already has the pattern for (`tunnelRoute: '/sentry-tunnel'`).

### 5.3 Workers runtime — viable now, but verify the SDK version

`posthog-node` ships a dedicated `workerd` export, and `wrangler.jsonc:10` already sets `nodejs_compat`. Two known Workers-specific defects to be aware of:

- **[posthog-js#3173](https://github.com/PostHog/posthog-js/issues/3173)** — `_flush()` never consumed the fetch response body, producing cross-request promise-cancellation warnings on Workers and silently cancelling post-flush continuations. **Fixed** in [#3516](https://github.com/PostHog/posthog-js/pull/3516), merged 2026-05-04 and released the same day. Pin **`posthog-node@5.33.2`** or later (and `@posthog/core@1.28.2` if it is ever depended on directly) — all three versions verified present on the npm registry.
- **[posthog#58394](https://github.com/posthog/posthog/issues/58394)** — `captureImmediate()` resolved before the HTTP request landed, dropping events in runtimes that freeze on response. Fixed from `posthog-node@5.8.1` onward, so the 5.33.2 pin above already covers it. Belt-and-braces, dispatch under `ctx.waitUntil` anyway — the pattern this codebase already uses for exactly this class of problem in `src/lib/marketing/conversions.ts`.

Both fixes are version-gated rather than workaround-gated, so the pin *is* the mitigation. If PostHog is ever actually adopted, the delivery path should get an end-to-end Workers check (a preview-only debug read asserting a captured event landed, in the shape of the existing `/api/debug/fulfilment-status` gate) — but that belongs with the implementation, not with this assessment.

Server-side config must be `flushAt: 1, flushInterval: 0`, with a fresh client per request. **`flushAt`/`flushInterval` are not a substitute for lifecycle finalisation** — call `posthog.shutdown()` after capturing and pass *that* promise to `ctx.waitUntil()`, so the isolate stays alive until the flush actually lands. Workable, and the existing conversions code is the template — but it is a third async fire-and-forget vendor call hanging off the Stripe webhook's critical path.

### 5.4 EU data residency is mandatory, not optional

PL-default store, EU customer base. PostHog Cloud **EU (Frankfurt)** only. That also means `NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com`, EU asset hosts in the CSP, and the EU WAF IPs (`3.75.65.221`, `18.197.246.42`, `3.120.223.253`) allowlisted if heatmaps are ever enabled. A DPA with PostHog would be needed alongside the existing Stripe/Supabase/Resend/Prodigi ones.

### 5.5 A second identity graph, landing on top of one being built right now

Plan 5 group G2 is actively threading GA4 `user_id` (the opaque Supabase user id) through `/api/auth/callback` and a one-shot cookie. PostHog needs its own `distinct_id` + `posthog.identify()` + `posthog.reset()` lifecycle, and — for server events to link to browser sessions — `tracing_headers` on `fetch` calls to our own API routes.

**Security note if that is ever wired up:** `tracing_headers` only makes the browser send `X-POSTHOG-DISTINCT-ID` / `X-POSTHOG-SESSION-ID`. Those are client-controlled and trivially spoofable, so they are **analytics context only** — a handler may pass them to `posthog-node` for event attribution, and must never treat them as identity for authorization. Authorization stays with the verified Supabase session, as it is today.

Adopting PostHog mid-flight means designing a second identity model against the same auth seam, before the first one has shipped and been verified. Sequencing matters more than the merits here.

### 5.6 Client bundle

`posthog-js` is a second client-side analytics bundle on a storefront that today ships only the GTM loader, on a site where product imagery is already the dominant payload. If flags are the only reason to load it, server-side flag evaluation in `posthog-node` avoids the client bundle entirely — at the cost of a network call in the request path.

---

## Recommendation

**Staged, and the first stage is deliberately reversible.**

### Stage 0 — do nothing yet, and consider that a legitimate answer

The analytics stack was audited and remediated across six plans between 2026-07-26 and 2026-07-29, with GTM v17 published 2026-07-29. As of this assessment (2026-08-03) the F-04 Meta CAPI dedup / advanced-matching soak (`docs/analytics-stack.md:182`) had not been recorded as closed — **verify its current status before relying on this paragraph**, which is a point-in-time note, not a standing fact. If it is still open, adding a new vendor means debugging two changes at once.

If nothing below is compelling enough to schedule properly, **the correct action is none** — and the highest-value analytics work available is finishing what's already queued: link the GA4 BigQuery export, and close out the F-04 soak.

### Stage 1 — the cheap, non-duplicative wins (recommended)

**Link the GA4 BigQuery export first** — it fixes `order_total` outright, it is free, it is already scripted, and it is the behaviour half of the join. Do this whether or not PostHog is ever adopted.

Then, if wanted: open a **PostHog Cloud EU** account, free tier, for **surveys** and — if the order↔behaviour join is actually wanted — the **warehouse connectors**.

- Surveys need the client SDK, so they carry the consent + CSP work in §5.1/§5.2. Do them **after** the CSP enforce cutover, not before.
- The **warehouse half needs both connectors** to be useful: PostHog's managed Supabase source (orders) *and* its BigQuery source pointed at the GA4 export (behaviour). Either alone is a dead end (§3.2). No `posthog-js` is involved, so this half avoids the **browser** consent, CSP, and bundle cost entirely — but it is not cost-free in privacy terms: syncing `orders` ships customer personal data to a new processor, which still needs the DPA in §5.4 and a deliberate decision about scope.
- **Sync only what the questions need.** Use a read-only Supabase role and a BigQuery service account scoped to the approved tables plus a dedicated temporary-table dataset (the BigQuery source needs create/query/delete rights for temp tables — give it a sandbox dataset, not the estate). Leave `orders.email`, `contact`, and `shipping_address` out of the synced column set: every §3.2 question joins on `product_id` / `order_id` / timestamps, none of them need identifiers.
- **The Supabase connector's CDC mode is alpha and has a production-facing failure mode.** It needs a *direct* connection (not the session pooler) plus the IPv4 add-on, and if PostHog cannot drain the replication slot fast enough Postgres retains WAL and can exhaust disk **on the production database**. If this is ever enabled, replication-slot and WAL monitoring are a prerequisite, not a follow-up.
- Cost: **$0** (1,500 survey responses + 1M warehouse rows/month free).
- Reversible: deleting the project removes the data; no code path depends on it.

### Stage 2 — feature flags, only when there is a flag worth having

Adopt flags at the point a real product-surface toggle appears — a new PDP layout, a configurator variant, a checkout copy change. Not before. Evaluate **server-side** (`posthog-node` in the Workers runtime, per §5.3) so no client bundle is added and the value is resolved before HTML is sent, avoiding hydration flicker.

That is not free, though: server-side evaluation puts a network call on the request path. Before flags touch a rendering path, fix a bounded `requestTimeout`, a safe default for every flag (fail to the current behaviour, never to the new one), and either local evaluation or caching so a slow or unreachable PostHog degrades the page rather than delaying it.

Do **not** migrate the existing ops kill switches (`SUPABASE_PUBLISHABLE_KEY`, `HIDDEN_CATEGORIES`, `CATALOG_SOURCE`). They are correctly fail-closed env vars and should stay that way.

### Stage 3 — experiments, prints only

If Stage 2 lands and traffic supports it, scope experiments to the **fine-art-prints** surface and sitewide layouts.

To be precise about why: unique inventory rules out **item-level treatment tests** — you cannot A/B a piece that sells once and is gone, sample size one. It does **not** make ceramic pages untestable per se; visitor-level layout and funnel experiments (PDP template, `/sklep` hub, checkout) assign on the visitor, not the item, and are perfectly valid there. Whether they are *useful* is a power question — traffic volume, eligible-visitor count, and controlled assignment — not a structural one. Prints are the recommended starting scope because repeatable inventory makes the item-level axis available too.

### Never

Error tracking, session replay, or product analytics. Sentry, Clarity, and GA4/Meta each own their lane and are more deeply integrated than PostHog would be for years. The Meta half specifically (Pixel + CAPI dedup, and the Google/Meta product feeds) is load-bearing for paid acquisition — and, per §2, it is independent of GA4 and would survive a GA4 swap. The objection to displacing GA4 is the shared `analytics.ts` → dataLayer → GTM transport, not a Meta dependency.

---

## Cost summary

Free tier, PostHog Cloud EU, per month:

| Product | Free allowance | Expected usage at this store's scale |
| --- | --- | --- |
| Surveys | 1,500 responses | Comfortably under |
| Data warehouse | 1M rows + free historical syncs | Comfortably under (orders are in the thousands) |
| Feature flags | 1M requests | Under, unless flags are evaluated per-request sitewide |
| Product analytics | 1M events | N/A — not adopting |
| Session replay | 5k recordings | N/A — not adopting |

Realistic bill for Stages 1–2: **$0/month**, 1 project, 1-year retention. Paid tier ($0 base, usage-based) buys 6 projects and 7-year retention if ever needed.

---

## Sources

- PostHog Next.js integration — https://posthog.com/docs/libraries/next-js
- PostHog Cloudflare Workers — https://posthog.com/docs/libraries/cloudflare-workers
- PostHog Node SDK — https://posthog.com/docs/libraries/node
- PostHog GDPR compliance — https://posthog.com/docs/privacy/gdpr-compliance
- PostHog data storage controls — https://posthog.com/docs/privacy/data-storage
- PostHog session-replay privacy controls — https://posthog.com/docs/session-replay/privacy
- PostHog Sentry integration — https://posthog.com/docs/libraries/sentry
- PostHog pricing — https://posthog.com/pricing
- Workers flush bug: [posthog-js#3173](https://github.com/PostHog/posthog-js/issues/3173) → fixed by [#3516](https://github.com/PostHog/posthog-js/pull/3516) (merged 2026-05-04)
- `captureImmediate` serverless drop: [posthog#58394](https://github.com/posthog/posthog/issues/58394)

Internal cross-references: `docs/analytics-stack.md`, `docs/audits/analytics-architecture-audit-2026-07-28.md`, `docs/superpowers/plans/2026-07-28-analytics-plans-index.md`.
