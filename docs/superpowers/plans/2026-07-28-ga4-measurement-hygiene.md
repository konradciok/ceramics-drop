# GA4 Configuration & Measurement Hygiene — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE: several tasks are GA4 Admin API / dashboard config, not code — those use checklist + verification-command steps rather than TDD.

**Goal:** Eliminate double-instrumentation, make ecommerce custom params queryable, and lock the value/variant conventions in docs.

**Architecture:** This is a configuration-and-documentation change plus one small code fix and three event deletions — it changes **no** analytics transport, dedup key, or payload-value convention. GA4 Enhanced Measurement and three new custom dimensions are set through the GA4 Admin API (service account, read-verified live this pass); the redundant hand-rolled scroll/form events are deleted so GA4's native Enhanced Measurement becomes the single owner of those behaviours; the Meta CAPI access token moves from the request URL into an `Authorization: Bearer` request header; and `docs/analytics-stack.md` is updated to state the value/variant conventions and record the config. The typed builder layer in `src/lib/analytics.ts` remains the event contract.

**Tech Stack:** GA4 Admin & Data API (service-account `.secrets/gtm-api-deploy.json`), TypeScript, Vitest, Meta CAPI.

## Global Constraints
- Build MUST stay `next build --webpack` — never Turbopack.
- GA4 property `539909256`, web stream `14989935436` (`G-WPJ3RE32M6`); auth via `.secrets/gtm-api-deploy.json` + `google-auth-library`.
- Do NOT change purchase payload `value` conventions in code (GA4=subtotal, Meta=total) — they are consistent client↔server; only document them.
- Custom-dimension registration is additive and safe; changing Enhanced Measurement toggles affects reporting going forward (not retroactive) — note it per task.
- Unit tests: `npx vitest run <file>`.

---

## The Enhanced-Measurement ownership decision (N-3) — stated once, referenced everywhere

**Decision:** GA4 Enhanced Measurement (EM) is the single owner of **scroll** and **form-interaction** behaviour. The redundant hand-rolled custom events are **removed** (Task 3), EM `scrollsEnabled`/`formInteractionsEnabled` stay **on**, and EM `siteSearchEnabled` is turned **off** (Task 2 — no real on-site search; the 20 live `view_search_results` are noise from inbound URLs carrying `s`/`q`). This is the "simpler, native" option from audit N-3.

**Accepted trade-offs (historical-reporting impact — none of this is retroactive):**
- **Scroll:** EM `scroll` fires once at **90%** only. The removed custom `scroll_depth` fired at **50% and 90%** — the 50% signal is lost going forward.
- **Contact form:** `<form id="contact-form">` (`ContactForm.tsx:16`) so EM `form_submit` carries `form_id=contact-form` and stays distinguishable — but the custom event's `topic` parameter is lost.
- **Newsletter form:** `<form>` has no `id`/`name` (`FooterNewsletterForm.tsx:48`), so EM `form_submit` reports it with an empty `form_id`. Optional one-liner in Task 3 adds `id="newsletter-form"` if newsletter-specific reporting is wanted; default is to skip it.

The inverse option (keep the custom events, disable the EM toggles) was **not** chosen.

---

## File Structure

**GA4 Admin API config surfaces (no repo file — set via `node -e` snippets below):**
- `properties/539909256/customDimensions` (**v1beta**) — POST 3 new EVENT-scoped dimensions (N-8).
- `properties/539909256/dataStreams/14989935436/enhancedMeasurementSettings` (**v1alpha** — confirmed live this pass; this resource does **not** exist under v1beta) — PATCH `siteSearchEnabled=false` (N-3).

**Code changed:**
- `src/lib/marketing/meta-capi.ts` + `src/lib/marketing/meta-capi.test.ts` — Meta CAPI token URL→`Authorization: Bearer` header (F-21, TDD).
- `src/components/analytics/AnalyticsEvents.tsx` — delete the `scroll_depth` machinery, keep `page_view` + `time_on_page` (N-3).
- `src/components/layout/FooterNewsletterForm.tsx` — **not changed here.** The newsletter event is retained and renamed to `newsletter_signup_requested` by Plan 3 (`2026-07-28-analytics-event-correctness.md`, N-10); native EM `form_submit` gives this footer form an empty `form_id`, so the named event stays as the newsletter-conversion signal.
- `src/components/shop/ContactForm.tsx` — delete the `contact_form_mailto_open` event + now-unused import (N-3).

**Docs changed:**
- `docs/analytics-stack.md` — value conventions (F-22), `item_variant` semantics (N-12), the N-11 cosmetic won't-fix note, the EM-ownership record (N-3), the new registered dimensions (N-8), and the `engagement_type` table + multi-currency drift sync (F-20 residual).

*No new script file is added — the Admin API calls are one-off inline `node -e` snippets. Skipped `scripts/ga4-admin.mjs`; add it only if GA4 Admin writes become routine.*

**Sequencing:** Task 1 and Task 2 (config) and Task 3 (code deletions) must land **before** Task 5 (docs), because Task 5 records those changes as done. Task 4 (F-21) is independent and can land any time.

---

## Task 1 — Register `order_total`, `checkout_total`, `shipping_tier` as GA4 custom dimensions (N-8)

These params are collected on `purchase`/`begin_checkout` but are unregistered, so they are unqueryable in Explore/reports. Registration is additive and safe (15/50 dimensions used → headroom is fine). **This is GA4 Admin config, not code.**

- [ ] **Pre-check — confirm the current 15 dimensions and that these 3 are absent.** Run from the repo root:
  ```bash
  node --input-type=module -e '
  import { GoogleAuth } from "google-auth-library";
  const auth = new GoogleAuth({ keyFile: ".secrets/gtm-api-deploy.json", scopes: ["https://www.googleapis.com/auth/analytics.readonly"] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const r = await fetch("https://analyticsadmin.googleapis.com/v1beta/properties/539909256/customDimensions", { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  console.log("count:", j.customDimensions.length);
  console.log("params:", j.customDimensions.map(d => d.parameterName).sort().join(","));
  '
  ```
  Expected output (verified live 2026-07-28):
  ```
  count: 15
  params: app_git_sha,app_version,engagement_type,filter_status,from_locale,item_category,item_id,locale,locker_name,method,page,reason,status,to_locale,topic
  ```
  (`order_total`, `checkout_total`, `shipping_tier` are not in the list.)

- [ ] **Create the 3 dimensions.** Note the `analytics.edit` scope (the write scope — the key has it, confirmed PR #201). `parameterName` must exactly match the event param; `scope` is `EVENT`:
  ```bash
  node --input-type=module -e '
  import { GoogleAuth } from "google-auth-library";
  const auth = new GoogleAuth({ keyFile: ".secrets/gtm-api-deploy.json", scopes: ["https://www.googleapis.com/auth/analytics.edit"] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const dims = [
    { parameterName: "order_total",    displayName: "Order total",    scope: "EVENT" },
    { parameterName: "checkout_total", displayName: "Checkout total", scope: "EVENT" },
    { parameterName: "shipping_tier",  displayName: "Shipping tier",  scope: "EVENT" },
  ];
  for (const d of dims) {
    const r = await fetch("https://analyticsadmin.googleapis.com/v1beta/properties/539909256/customDimensions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(d),
    });
    const j = await r.json();
    console.log(d.parameterName, r.status, j.name ?? j.error?.message);
  }
  '
  ```
  Expected output (one line per dimension):
  ```
  order_total 200 properties/539909256/customDimensions/<id>
  checkout_total 200 properties/539909256/customDimensions/<id>
  shipping_tier 200 properties/539909256/customDimensions/<id>
  ```
  If a dimension already exists, GA4 returns `400/409 ... already exists` for that one — safe to ignore **only if** it is still an active dimension (the create is effectively idempotent; leave the existing dimension in place).

  > **Run 2026-07-29:** `checkout_total` + `shipping_tier` created (200). `order_total` returned `409 ALREADY_EXISTS` **but is absent from the active list** — an archived `order_total`/EVENT dimension holds the slot, and the Admin API has no un-archive (`create`/`get`/`list`/`patch`/`archive` only). So this landed at **17** dimensions, not 18; a queryable `order_total` needs a manual restore in the GA4 UI (Admin → Custom definitions).

- [ ] **Verify — re-list and confirm 18 dimensions including the 3 new params.** Re-run the pre-check snippet. Expected output:
  ```
  count: 18
  params: app_git_sha,app_version,checkout_total,engagement_type,filter_status,from_locale,item_category,item_id,locale,locker_name,method,order_total,page,reason,shipping_tier,status,to_locale,topic
  ```
  (`checkout_total`, `order_total`, `shipping_tier` now present.)

---

## Task 2 — Disable GA4 Enhanced Measurement site search (N-3, config)

See "The Enhanced-Measurement ownership decision" above. Turning off `siteSearchEnabled` stops the noise `view_search_results` events. **This is GA4 Admin config, not code — the change is not retroactive** (existing `view_search_results` rows remain in historical reports; no new ones are collected).

- [ ] **Pre-check — confirm EM current state (site search on).** The `enhancedMeasurementSettings` resource is **v1alpha only**:
  ```bash
  node --input-type=module -e '
  import { GoogleAuth } from "google-auth-library";
  const auth = new GoogleAuth({ keyFile: ".secrets/gtm-api-deploy.json", scopes: ["https://www.googleapis.com/auth/analytics.readonly"] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const r = await fetch("https://analyticsadmin.googleapis.com/v1alpha/properties/539909256/dataStreams/14989935436/enhancedMeasurementSettings", { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  console.log("siteSearch:", j.siteSearchEnabled, "scrolls:", j.scrollsEnabled, "forms:", j.formInteractionsEnabled, "searchQueryParameter:", j.searchQueryParameter);
  '
  ```
  Expected output (verified live 2026-07-28):
  ```
  siteSearch: true scrolls: true forms: true searchQueryParameter: q,s,search,query,keyword
  ```

- [ ] **PATCH `siteSearchEnabled=false`** (leave `scrollsEnabled`/`formInteractionsEnabled` untouched — the `updateMask` scopes the write to the one field):
  ```bash
  node --input-type=module -e '
  import { GoogleAuth } from "google-auth-library";
  const auth = new GoogleAuth({ keyFile: ".secrets/gtm-api-deploy.json", scopes: ["https://www.googleapis.com/auth/analytics.edit"] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const url = "https://analyticsadmin.googleapis.com/v1alpha/properties/539909256/dataStreams/14989935436/enhancedMeasurementSettings?updateMask=siteSearchEnabled";
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ siteSearchEnabled: false }),
  });
  const j = await r.json();
  console.log(r.status, "siteSearchEnabled:", j.siteSearchEnabled);
  '
  ```
  Expected output:
  ```
  200 siteSearchEnabled: false
  ```

- [ ] **Verify — re-run the pre-check snippet.** Expected output (scroll/form still on, site search now off):
  ```
  siteSearch: false scrolls: true forms: true searchQueryParameter: q,s,search,query,keyword
  ```

---

## Task 3 — Remove the 3 redundant custom events (N-3, code deletions)

Per the ownership decision, delete the hand-rolled `scroll_depth` and `contact_form_mailto_open` events (EM already covers them) — **checklist + verification, not TDD.**

> **Reconciliation (cross-plan):** `newsletter_signup` is **NOT** deleted here. Plan 3 (`2026-07-28-analytics-event-correctness.md`, N-10) renames it to `newsletter_signup_requested` and keeps it, because native EM `form_submit` reports an **empty `form_id`** for the footer form (see Task 5's trade-off note) — so a named custom event is the only reliable newsletter-conversion signal. Do only the two deletions below.

- [ ] **`AnalyticsEvents.tsx` — delete the `scroll_depth` machinery, keep `page_view` + `time_on_page`.** Replace the entire second `useEffect` (the one with the scroll listener, `firedDepths`, `measureDepth`, `onScroll`, `rafId`) with a timer-only effect. The final block should read:
  ```tsx
  useEffect(() => {
    const timer = window.setTimeout(() => {
      pushDataLayer(
        buildEngagementEvent('time_on_page', {
          engagement_seconds: 30,
          page_path: redactSensitiveUrl(`${window.location.pathname}${window.location.search}`),
        }),
      );
    }, 30000);
    return () => window.clearTimeout(timer);
  }, [pathname]);
  ```
  Imports are unchanged — `buildEngagementEvent`, `pushDataLayer`, `redactSensitiveUrl`, `buildPageViewEvent` all still used.

- [ ] **`FooterNewsletterForm.tsx` — no change (newsletter event retained).** Its fate is owned by Plan 3 (N-10), which renames the event to `newsletter_signup_requested`. Skip this file for N-3. *(If someone later wants native EM to segment the newsletter form, add `id="newsletter-form"` to the `<form className="footer-newsletter" ...>` element — but that's independent of this plan.)*

- [ ] **`ContactForm.tsx` — delete the `contact_form_mailto_open` event.** Remove the line `pushDataLayer(buildEngagementEvent('contact_form_mailto_open', { topic }));` (currently line 28) and its two-line explanatory comment above it. `topic` stays in scope — it's still used by `buildContactMailto`'s subject below. Then remove the now-unused import (currently line 6):
  ```ts
  import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';
  ```

- [ ] **Verify — the two removed event names are gone from `src/` (test files excluded):**
  ```bash
  grep -rn "scroll_depth\|contact_form_mailto_open" src --include='*.tsx' --include='*.ts' | grep -v '\.test\.'
  ```
  Expected output: **(no output — exit code 1)**. (`newsletter_signup` is intentionally retained by Plan 3 as `newsletter_signup_requested`.)

- [ ] **Verify — types, lint, and unit tests are clean** (lint catches any missed unused import):
  ```bash
  npm run typecheck && npm run lint && npm run test
  ```
  Expected: all three exit 0.

---

## Task 4 — Move the Meta CAPI access token from URL query to the `Authorization` header (F-21, TDD)

`sendMetaPurchase` puts `?access_token=<token>` in the request URL (`meta-capi.ts:75-77`), so the credential lands in Meta's server logs, any intermediary proxy logs, and Sentry breadcrumbs that capture URLs. The Graph API also accepts the token as an `Authorization: Bearer <token>` request header — move it there and drop it from the URL. (Do **not** put it in the JSON body: the Graph API does not read `access_token` from a JSON POST body, so that would fail auth.) `buildMetaPurchasePayload` stays a pure event-shape builder and the POST body is unchanged (purchase payload + optional `test_event_code`); the token is supplied at send time via the request header. **Use TDD.**

- [ ] **RED — update the `sendMetaPurchase` assertions** in `src/lib/marketing/meta-capi.test.ts`. In the `it('POSTs to the graph endpoint and reports ok', ...)` block, replace:
  ```ts
      expect(url).toContain('access_token=TOK');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).not.toHaveProperty('test_event_code');
  ```
  with:
  ```ts
      expect(url).not.toContain('access_token'); // F-21: token no longer in URL
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer TOK'); // token in header, not URL or body
      expect(JSON.parse(init.body)).not.toHaveProperty('access_token');
      expect(JSON.parse(init.body)).not.toHaveProperty('test_event_code');
  ```

- [ ] **RED — run the test and watch it fail:**
  ```bash
  npx vitest run src/lib/marketing/meta-capi.test.ts
  ```
  Expected: the `POSTs to the graph endpoint` test fails — `url` still contains `access_token=TOK` and `init.headers.Authorization` is `undefined`. (The other 10 tests still pass; baseline is 11 passing before this change.)

- [ ] **GREEN — apply the fix** in `src/lib/marketing/meta-capi.ts`. Drop `?access_token=` from the URL and add the `Authorization: Bearer` header to the `fetchImpl` call — the `body` is unchanged (payload + optional `test_event_code`, no `access_token`). Replace:
  ```ts
    const url =
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.pixelId}/events` +
      `?access_token=${encodeURIComponent(config.accessToken)}`;
    const body = {
      ...buildMetaPurchasePayload(input),
      ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
    };
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  ```
  with:
  ```ts
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.pixelId}/events`;
    const body = {
      ...buildMetaPurchasePayload(input),
      ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
    };
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  ```

- [ ] **GREEN — re-run the test:**
  ```bash
  npx vitest run src/lib/marketing/meta-capi.test.ts
  ```
  Expected output:
  ```
   Test Files  1 passed (1)
        Tests  11 passed (11)
  ```

- [ ] **Verify types are clean:**
  ```bash
  npm run typecheck
  ```
  Expected: exit 0.

---

## Task 5 — Sync `docs/analytics-stack.md` (F-22, N-12, N-11, N-8, N-3 record, F-20 residual)

Documentation-only. Lock the conventions and record the config changes from Tasks 1-3. **Do this after Tasks 1-3 land.** Checklist + grep verification (no build step for Markdown).

- [ ] **F-22 — value convention.** In the "GA4 ecommerce payloads use:" list (the `ecommerce.value` / `order_total` bullets, ~lines 58-60), make the split explicit. State that the **GA4** `ecommerce.value` is the **item subtotal (excludes shipping)** while the **Meta** `value` (browser `meta.value` and server CAPI) is the **order total (includes shipping)**, and that both are internally consistent client↔server (this is by design, F-22 — do not "fix" it).

- [ ] **N-12 — `item_variant` semantics.** On/near the `items[]` bullet (~line 62), add a note: for one-of-a-kind **ceramics**, `item_variant` carries the piece number `Nº <num>` — there is no variant axis, each piece is unique — whereas for **prints** it carries the real size/frame variant label. Note this is a deliberate semantic overload (a ceramic "variant" dimension is effectively a per-piece id); payloads are not changing.

- [ ] **N-11 — revenue float noise, documented as won't-fix (cosmetic).** Add a short note under "Server-side Conversions" (or beside the value bullets): GA4's aggregate revenue can show float tails (e.g. `11134.000004`). This is a GA4-side summation artifact across transactions, **not** a per-event defect — the server emits `value = order.subtotal / 100` (grosze summed once, then one division; `conversions.ts:123`) and the client `sumItems` rounds to 2 dp (`analytics.ts:511`), so every individual event value is already exact. A client-side "sum minor units then divide once" refactor is not possible (client items carry major-unit prices only) and is unjustified for a 6th-decimal cosmetic tail — **won't fix.**

- [ ] **N-8 — record the new registered dimensions.** In the custom-dimensions note (the paragraph ending "...usable in Explore/reports now.", ~line 66), append that `order_total`, `checkout_total`, and `shipping_tier` were registered as event-scoped custom dimensions 2026-07-28 (closing audit N-8), so they are now queryable.

- [ ] **N-3 — record the EM-ownership decision.** Add a short subsection (e.g. under the Enhanced Measurement / event-contract area) stating: GA4 Enhanced Measurement owns scroll + form interactions; `siteSearchEnabled` was turned **off** 2026-07-28 (no on-site search); and the custom `scroll_depth` and `contact_form_mailto_open` events were removed (the newsletter event is **retained** as `newsletter_signup_requested` — Plan 3 — because native `form_submit` reports an empty `form_id` for it). Note the non-retroactive trade-offs: scroll now measured at 90% only (was 50%+90%); contact form distinguishable via `form_id=contact-form` but loses `topic`.

- [ ] **F-20 residual — complete the `engagement_type` table + multi-currency note.** The table (~lines 43-53) is missing rows for events that are still emitted. Add these six rows (verified against `buildEngagementEvent` call sites this pass), and do **not** add rows for the two events removed in Task 3 (`scroll_depth`, `contact_form_mailto_open`); `newsletter_signup_requested` is documented by Plan 3, not here:

  | `engagement_type` | When | Extra params |
  | --- | --- | --- |
  | `time_on_page` | 30 s dwell on a page (`AnalyticsEvents.tsx`) | `engagement_seconds` (30), `page_path` |
  | `showroom_product_view` | buyer views a not-for-sale showroom tile (`ProductTile.tsx`) | `item_id`, `item_name`, `item_category`, `price`, `currency` |
  | `showroom_view` | showroom section renders (`ShowroomViewAnalytics.tsx`) | `count` |
  | `showroom_interest_submit` | buyer submits the showroom interest form (`ShowroomInterestForm.tsx`) | `item_id` |
  | `cart_clear` | buyer clears the selection bar (`SelectionBar.tsx`) | `item_ids`, `value`, `currency` |
  | `cart_cta_click` | buyer clicks the selection-bar "go to cart" CTA (`SelectionBar.tsx`) | `location`, `num_items`, `value`, `currency` |

  Add a one-line multi-currency note below the table: the money-carrying demand params on `showroom_product_view`/`sold_item_view`/`cart_clear`/`cart_cta_click` are currency-labelled — Plan 3 (`2026-07-28-analytics-event-correctness.md`, N-5) adds a `currency` sibling and a display-currency amount to all four. (`sold_item_view` is already a documented row in this table; its `currency` update ships with N-5, so it is **not** re-added here — the three new rows above already include `currency`.)

- [ ] **Verify — the six new engagement types are documented and the three removed ones are not listed as active rows:**
  ```bash
  grep -c "time_on_page\|showroom_product_view\|showroom_view\|showroom_interest_submit\|cart_clear\|cart_cta_click" docs/analytics-stack.md
  ```
  Expected: a count `>= 6` (the six new rows present).
  ```bash
  grep -n "contact_form_mailto_open\|scroll_depth" docs/analytics-stack.md
  ```
  Expected: matches appear **only** inside the N-3 "removed" note — never as `| engagement_type |` table rows. (`newsletter_signup_requested` is documented as an active row by Plan 3, N-10.)

- [ ] **Verify — the value/variant/won't-fix conventions are stated:**
  ```bash
  grep -in "excludes shipping\|includes shipping\|won't fix\|piece number" docs/analytics-stack.md
  ```
  Expected: at least one hit each for the shipping-inclusion split, the N-11 won't-fix note, and the N-12 piece-number semantics.

---

## Done-when

- [x] GA4 property `539909256` custom dimensions — `checkout_total` + `shipping_tier` registered 2026-07-29 (count 15→**17**). `order_total` **blocked** by an archived same-name dimension (409 ALREADY_EXISTS, no un-archive API); needs a manual GA4-UI restore to reach 18 (Task 1 run note).
- [x] EM `siteSearchEnabled` is `false` (GA4 omits the field when false), `scrollsEnabled`/`formInteractionsEnabled` still `true` — verified 2026-07-29 (Task 2 verify).
- [x] `grep` finds no `scroll_depth`/`contact_form_mailto_open` in `src/` (Task 3 verify; `newsletter_signup_requested` is retained per Plan 3); `npm run typecheck && npm run lint && npm run test` all pass (130 files, 1669 tests, 2026-07-29).
- [x] `npx vitest run src/lib/marketing/meta-capi.test.ts` → 11 passed, with the token in the `Authorization: Bearer` header and absent from both the URL and the POST body (Task 4).
- [x] `docs/analytics-stack.md` states the value/variant conventions, the N-11 won't-fix decision, the EM-ownership record, and the completed `engagement_type` table (Task 5 verify).

**Residual follow-up (not blocking this plan):** `order_total` remains unqueryable until someone restores or renames the archived same-name dimension in the GA4 UI — see the Task 1 run note. Everything else in Plan 4 is complete.
