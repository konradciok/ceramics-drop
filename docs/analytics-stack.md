# Analytics Stack: GA4 + Meta Pixel via GTM

This storefront sends analytics events only to `window.dataLayer`. Google Analytics 4 and Meta Pixel are configured in Google Tag Manager, so app code does not call `gtag()` or `fbq()` directly.

## App Configuration

Copy `.env.example` to `.env.local` and fill:

```bash
NEXT_PUBLIC_GTM_ID=GTM-XXXXXXX
NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-XXXXXXXXXX
NEXT_PUBLIC_META_PIXEL_ID=000000000000000

GCP_PROJECT_ID=your-google-cloud-project-id
GTM_ACCOUNT_ID=000000000
GTM_CONTAINER_ID=000000000
GTM_WORKSPACE_NAME=ACC analytics stack
```

`NEXT_PUBLIC_GTM_ID` controls whether the app loads GTM. If it is empty, no GTM script is injected.

## Event Contract

The app pushes these events:

| Event | When | GA4 purpose | Meta mapping |
| --- | --- | --- | --- |
| `page_view` | initial render and route changes | page reporting | `PageView` |
| `view_item_list` | collection gallery render | ecommerce list view | none |
| `select_item` | product tile opens lightbox | ecommerce product selection | none |
| `view_item` | lightbox displays product | ecommerce product detail | `ViewContent` |
| `add_to_cart` | product is actually added | ecommerce add to cart | `AddToCart` |
| `remove_from_cart` | product is removed | ecommerce cart removal | none |
| `view_cart` | cart page renders with items | ecommerce cart view | none |
| `begin_checkout` | checkout button click | checkout start | `InitiateCheckout` |
| `purchase` | confirmed payment / order success | purchase conversion | `Purchase` |
| `site_engagement` | 30s dwell, language switch, delivery/locker selection, showroom demand, cart CTA/clear, plus the custom events below | engagement reporting | `SiteEngagement` custom event |

`consent_update` is a GTM-internal signal only — pushed by `setConsent()` in `src/components/consent/consent-mode.ts` right after its `gtag('consent','update',...)` call, so GTM's `ACC - Consent Update` trigger can give the two base tags (and Microsoft Clarity) a fresh chance to fire if a visitor accepts consent mid-session rather than arriving with it already granted. Deliberately excluded from `ANALYTICS_EVENTS`, so it's never forwarded to GA4/Meta as a fake event.

All custom events ride the single `site_engagement` dataLayer event, distinguished by the `engagement_type` parameter (built by `buildEngagementEvent(type, props)` in `src/lib/analytics.ts`). The GTM container already forwards `site_engagement` generically, so these reach GA4 with **no per-event tag** — register `engagement_type` (and any new param) as GA4 custom dimensions to report on them.

| `engagement_type` | When | Extra params |
| --- | --- | --- |
| `language_change` | PL/EN/ES switch | `from_locale`, `to_locale`, `page_path` |
| `parcel_locker_select` | buyer picks the InPost Paczkomat delivery method | `method`, `page` |
| `courier_select` | buyer picks courier delivery | `method`, `page` |
| `pickup_select` | buyer picks free Warsaw studio pickup | `method`, `page` |
| `parcel_locker_point_selected` | buyer completes InPost locker selection in the Geowidget | `locker_name` |
| `sold_item_view` | buyer clicks an already-sold tile (demand signal for drops) | `item_id`, `item_name`, `item_category`, `price`, `currency` |
| `newsletter_signup_requested` | footer newsletter POST accepted — step 1 of the double opt-in (a confirmation email was sent; NOT a confirmed subscription — the confirmed-contact count lives in Resend) | — |
| `shop_filter` | buyer narrows the shop view via the status filter (sold/available) | `filter_status` (`all` \| `available` \| `sold`) |
| `checkout_error` | pre-payment `/api/checkout` failure | `reason` (`sold_out` \| `rate_limited` \| `checkout_failed` \| `network_error` \| `response_parse_error` \| `order_conflict` \| `checkout_in_progress`), `status`, `sold_count` |
| `payment_failed` | Stripe PaymentIntent failed/canceled on `/koszyk/return` | `status` (PaymentIntent status; the PI id is never sent). Deduped once per PaymentIntent via `pushPaymentFailedOnce` so refresh / Strict-Mode double-mount doesn't inflate counts. The `status` param preserves granularity (e.g. `canceled` vs. `requires_payment_method`). |
| `time_on_page` | 30 s dwell on a page (`AnalyticsEvents.tsx`) | `engagement_seconds` (always 30), `page_path` (token-redacted) |
| `showroom_product_view` | buyer views a not-for-sale showroom tile (`ProductTile.tsx`) | `item_id`, `item_name`, `item_category`, `price`, `currency` |
| `showroom_view` | showroom section renders, once per page load (`ShowroomViewAnalytics.tsx`) | `count` |
| `showroom_interest_submit` | buyer submits the showroom interest form (`ShowroomInterestForm.tsx`) | `item_id` |
| `cart_clear` | buyer clears the selection bar (`SelectionBar.tsx`) | `item_ids`, `value`, `currency` |
| `cart_cta_click` | buyer clicks the selection-bar "go to cart" CTA (`SelectionBar.tsx`) | `location` (`selection_bar`), `num_items`, `value`, `currency` |

**Multi-currency:** the money-carrying demand params on `showroom_product_view` / `sold_item_view` / `cart_clear` / `cart_cta_click` are currency-labelled — each sends a `currency` sibling alongside a display-currency amount, so a PLN and a EUR signal are never summed as if they were the same unit (Plan 3, N-5: `docs/superpowers/plans/2026-07-28-analytics-event-correctness.md`).

GA4 ecommerce payloads use:

- `currency`: the buyer's display currency (`PLN`/`EUR`/`GBP`) — derived client-side from `useCurrency()` (`src/components/currency/CurrencyProvider.tsx`, seeded from the `currency_pref` cookie) via `currencyFormatter()` in `src/lib/format.ts`; server-side conversions (`src/lib/marketing/conversions.ts`) use the persisted `orders.currency` column instead. `ANALYTICS_CURRENCY` (`'PLN'`) in `src/lib/analytics.ts` is only a fallback default for callers that omit `currency` explicitly.
- `ecommerce.value`: item subtotal — **excludes shipping**
- `ecommerce.shipping`: shipping cost on purchase
- `order_total`: subtotal plus shipping as a custom parameter
- `transaction_id`: order number for `purchase`
- `items[]`: `item_id`, `item_name`, `item_brand`, `item_category`, `item_variant`, `price`, `quantity`

**`value` convention: GA4 and Meta deliberately differ (F-22 — do not "fix" this).** The GA4 `ecommerce.value` is the **item subtotal (excludes shipping)**; the Meta `value` — both the browser `meta.value` and the server CAPI `custom_data.value` — is the **order total (includes shipping)**. Each channel is internally consistent client↔server (the browser and the webhook send the same figure for the same order), which is what dedup and channel-level revenue reporting need. Equalising the two across channels is not a goal and would break the existing Meta baseline.

**`item_variant` semantics (N-12).** For one-of-a-kind **ceramics** `item_variant` carries the piece number `Nº <num>` — there is no variant axis, every piece is unique, so the "variant" dimension is effectively a per-piece id. For **fine-art prints** it carries the real variant label (size / frame). This is a deliberate semantic overload of one GA4 field across two product kinds; payloads are **not** changing. When segmenting by `item_variant`, filter by `item_category` first (`fine-art-prints` vs. a ceramic category) or the two meanings mix in one report.

**Revenue float tails are a GA4-side artifact — won't fix (N-11, cosmetic).** GA4's aggregate revenue can display float tails (e.g. `11134.000004`). That is GA4 summing many already-exact per-event values in binary floating point, **not** a per-event defect: the server emits `value = order.subtotal / 100` (grosze summed once as integers, then one division — `conversions.ts`) and the client `sumItems` rounds to 2 dp (`analytics.ts`), so every individual event value is exact. A client-side "sum minor units then divide once" refactor is not possible (client-side items carry major-unit prices only) and is unjustified for a 6th-decimal display artifact.

Meta payloads use standard event names where available and include `event_id` for future browser/server deduplication.

Every event also carries `app_version` (semver from `package.json`) and `app_git_sha` (short git SHA, or `"dev"` for builds without git), stamped by `pushDataLayer()` in `src/lib/analytics.ts` from `NEXT_PUBLIC_APP_VERSION`/`NEXT_PUBLIC_GIT_SHA` (`next.config.ts`) — the same build-time constants already used for the Sentry release and the admin footer badge. The GTM bridge forwards them to GA4 generically like any other param. Registered as event-scoped GA4 custom dimensions 2026-07-27 (`app_version` → "Wersja aplikacji", `app_git_sha` → "SHA commita"), closing the manual follow-up left open by #189 — usable in Explore/reports now. Three further event-scoped dimensions are **pending registration** (audit N-8): `order_total`, `checkout_total`, and `shipping_tier`. All three are already collected on `purchase`/`begin_checkout` but are unregistered and therefore unqueryable in Explore/reports. Registration is additive, safe (15/50 dimensions used), and non-retroactive — the dimensions populate from the registration date forward. It requires the gitignored `.secrets/gtm-api-deploy.json` key, so it is an operator step; the exact `node -e` snippets are in Task 1 of `docs/superpowers/plans/2026-07-28-ga4-measurement-hygiene.md`. Update this paragraph to record the date once run.

### Enhanced Measurement ownership (N-3)

**GA4 Enhanced Measurement is the single owner of scroll and form-interaction measurement.** EM `scrollsEnabled` and `formInteractionsEnabled` stay **on**, and the redundant hand-rolled `scroll_depth` and `contact_form_mailto_open` custom events were **removed** from the app 2026-07-28.

The matching GA4-side toggle — turning EM `siteSearchEnabled` **off** — is **pending operator action** (same `.secrets/gtm-api-deploy.json` requirement; snippets in Task 2 of the plan). This store has no on-site search, so the live `view_search_results` events are noise from inbound URLs that happen to carry `s`/`q` params. Until it is switched off that noise keeps accruing; the app-side deletions above are independent and already effective.

The newsletter event is **retained** as `newsletter_signup_requested` (see the table above). It is the one form event EM cannot replace: `FooterNewsletterForm`'s `<form>` has no `id`/`name`, so native `form_submit` reports it with an empty `form_id` and it can't be told apart from any other form. The named custom event remains the reliable newsletter-conversion signal.

Accepted trade-offs — **none of this is retroactive**; historical rows are unaffected and only collection going forward changes:

- **Scroll:** EM `scroll` fires once, at **90%**. The removed custom `scroll_depth` fired at **50% and 90%**, so the 50% mid-page signal is no longer collected.
- **Contact form:** `<form id="contact-form">` (`ContactForm.tsx`), so EM `form_submit` carries `form_id=contact-form` and stays distinguishable in reports — but the custom event's `topic` parameter (which enquiry category the visitor picked) is lost.
- **Site search:** once the toggle is flipped, existing `view_search_results` rows remain in historical reports and no new ones are collected.

## GA4 Property Configuration

`properties/539909256` (`ceramics`, under the `Shopify` GA4 account — the real production property) audited and corrected 2026-07-27 via the GA4 Admin API:

- **Key events**: only `purchase` (`keyEvents/14989935437`). Removed `close_convert_lead`/`qualify_lead` (generic lead-gen template defaults, irrelevant to this store) and `view_item`/`add_to_cart`/`begin_checkout` (funnel-diagnostic events, not conversions — view them via Explorations/funnel reports instead; marking them as key events dilutes conversion-rate metrics).
- **Data retention**: `eventDataRetention` and `userDataRetention` both at the 14-month max (event retention was previously stuck at GA4's 2-month default — only affects Explore/funnel/cohort analysis, not standard reports or the Data API, and isn't retroactive).
- **Google Signals**: enabled, for cross-device reporting and demographics/interest breakdowns. Privacy exposure is governed by the existing Consent Mode v2 setup (`src/components/consent/`), not this toggle — a June 2026 GA4 platform change made the `ad_storage` consent signal the real gate for data reaching any linked Google Ads account (none is currently linked here).
- **Reporting currency**: `PLN` (previously EUR) — matches `pl`, this store's default/home-market locale. This is the property-level fallback/aggregate-reporting currency only; every ecommerce event already sends its own correct per-transaction `currency` (see the Event Contract section above).
- **BigQuery export**: not yet linked. `scripts/bq-query.mjs`'s prerequisite step (GA4 Admin → Property → Product Links → BigQuery Links) is still outstanding — `npm run bq:query` will fail its own dataset-existence check until this is done.

## Google Cloud and GTM API Auth

The GTM and GA4 scripts authenticate with the `gtm-api-deploy` service account:

- Project: `anna-ciok-studio-analytics`
- Service account: `gtm-api-deploy@anna-ciok-studio-analytics.iam.gserviceaccount.com`
- Local key file: `.secrets/gtm-api-deploy.json` (gitignored)

One-time setup:

```bash
gcloud config set project anna-ciok-studio-analytics
gcloud services enable tagmanager.googleapis.com --project anna-ciok-studio-analytics
npm run gtm:key
```

The service account must have access to the GTM container. Grant that in GCP / Google Marketing Platform for the `anna-ciok-studio-analytics` project, or via an admin who can attach the service account to the GTM account programmatically. The GTM **User management** UI only accepts human Google accounts, not `@iam.gserviceaccount.com` emails. It also has GA4 property access (Data API read + Admin API read/write, e.g. custom dimensions) — see `npm run ga4:report` and `docs/analytics-stack.md`'s custom-dimensions notes above.

Then list accessible GTM accounts and containers:

```bash
npm run gtm:list
```

After filling `GTM_ACCOUNT_ID`, `GTM_CONTAINER_ID`, `NEXT_PUBLIC_GTM_ID`, `NEXT_PUBLIC_GA4_MEASUREMENT_ID`, and `NEXT_PUBLIC_META_PIXEL_ID`:

```bash
npm run gtm:setup
```

The setup creates or updates a GTM workspace named `ACC analytics stack` with:

- trigger `ACC - Initialization`
- trigger `ACC - analytics dataLayer events`
- tag `ACC - GA4 base`
- tag `ACC - Meta Pixel base`
- tag `ACC - GA4 dataLayer bridge`
- tag `ACC - Meta dataLayer bridge`

It does not publish by default. Use GTM Preview / Tag Assistant first, then publish with:

```bash
npm run gtm:setup -- --publish
```

## Verification Checklist

1. Start the site with `NEXT_PUBLIC_GTM_ID` set.
2. Open GTM Preview for the same container.
3. Visit the home page and a collection page.
4. Confirm `page_view` and `view_item_list` appear in the Preview timeline.
5. Open a product lightbox and confirm `select_item` then `view_item`.
6. Add a product and confirm `add_to_cart`.
7. Open the cart and confirm `view_cart`.
8. Click checkout and confirm `begin_checkout`.
9. After the payment flow confirms the order, confirm one `purchase` with one `transaction_id`.
10. Check GA4 DebugView for the GA4 event names.
11. Check Meta Events Manager Test Events for `PageView`, `ViewContent`, `AddToCart`, `InitiateCheckout`, and `Purchase`.

## Container Change Checklist

Whenever the GTM container (`GTM-NPHLG9NR`) tags/triggers change — via `npm run gtm:setup -- --publish` or a manual edit in the GTM UI:

1. In GTM UI → Admin → Container → Export Container, export the newly published version.
2. Save it as `docs/GTM-NPHLG9NR_v<N>.json` (N = the published version number) and remove the previous export file.
3. Confirm every consent-relevant tag still shows `consentSettings.consentStatus: "needed"` in the export, gated on `analytics_storage` or `ad_storage` as appropriate, **and** that `ACC - GA4 base`, `ACC - Meta Pixel base`, and `Microsoft Clarity - Official` each fire on two triggers (`ACC - Initialization`/its own base trigger, plus `ACC - Consent Update`) — this is what lets them recover if a visitor accepts consent mid-session instead of on load. This covers the 4 `ACC - *` Custom HTML tags (`ACC - GA4 base`, `ACC - Meta Pixel base`, `ACC - GA4 dataLayer bridge`, `ACC - Meta dataLayer bridge` — gated via `consentTypes` in `scripts/gtm-api.mjs`) **and any tag added directly in the GTM UI** (e.g. `Microsoft Clarity - Official`, on `analytics_storage`) — those aren't managed by `gtm-api.mjs` and default to ungated, so a UI-added tag needs its consent status set by hand.
4. Commit the new export in the same change as the container edit — a stale export is worse than no export.

**F-02 verified 2026-07-25** (event-system-audit): live version was 10, all 4 `ACC - *` tags correctly gated. One gap found in the process: `Microsoft Clarity - Official` — added directly in the GTM UI at some point after the `v3.json` export, outside `gtm-api.mjs` — was live with `consentStatus: notSet`, firing for every visitor regardless of consent choice. Gated it to `analytics_storage` (matching GA4's treatment) and republished as version 12.

**Consent-update re-fire fixed 2026-07-27** (`docs/superpowers/specs/2026-07-27-gtm-consent-refire-design.md`): GTM's Additional Consent Checks only gate a tag at the moment its own trigger fires — a visitor who accepted the cookie banner mid-session (rather than arriving with consent already granted) got no tracking at all for that session, since `ACC - GA4 base`/`ACC - Meta Pixel base` fired on a one-shot `Initialization` trigger and Clarity had the same shape of gap. Added the `ACC - Consent Update` trigger (matching the new `consent_update` dataLayer event from `setConsent()`) as a second firing trigger on all three tags and republished as version 13; export saved as `docs/GTM-NPHLG9NR_v13.json`. **Not verified in GTM Preview before publishing** (Claude in Chrome extension was unavailable; published on explicit user decision) — the community-reported "once per page consumes the firing budget even when blocked" GTM quirk has not been empirically ruled out for the two base tags. If tracking still doesn't recover after a mid-session Accept, check that first.

**N-1 `page_location` redaction — published as version 14 (2026-07-28).** `ga4BaseHtml()` and `ga4BridgeHtml()` in `scripts/gtm-api.mjs` seed a redacted `page_location` into the GA4 config (and refresh it on SPA `page_view`), so GA4 auto-events (`session_start`/`first_visit`) that fire before the app can `history.replaceState` never carry `?order=`/`?payment_intent[_client_secret]=`/`?sale=`/`?preview=`. See `docs/superpowers/plans/2026-07-28-analytics-privacy-token-redaction.md` Task 4. The app-layer `history.replaceState` strip (layer 1, shipped in PR #208) is the primary defence; this GA4-layer redaction (layer 2) closes the auto-event leak path that fires before React runs. Current export is `docs/GTM-NPHLG9NR_v14.json`; `_v13.json` is **retained** as the committed rollback reference for the Plan 6 native-tags migration (`docs/superpowers/plans/2026-07-28-gtm-native-tags-migration.md`), so v13 and v14 coexist until Plan 6 lands.

## Current storefront status

The storefront now uses the live Stripe checkout flow.
On checkout start, the app:
1. emits `begin_checkout`
2. saves a browser-side cart snapshot with `rememberCheckoutForReturn(...)`

On `/koszyk/return`, after Stripe confirms a successful PaymentIntent, the app calls
`pushConfirmedPurchaseFromRememberedCheckout(...)` and then clears the cart.

Those helpers in `src/lib/checkout-analytics.ts` keep the purchase payload intact even after
inventory marks the pieces as sold, and they deduplicate the browser-side `purchase` event so it
fires only once per `payment_intent`.
If the return page has a Stripe-backed `order_id`, pass that through as the analytics
`transaction_id`; otherwise the helper can fall back to `paymentIntent.id`.

## Production Note

The app already implements Google Consent Mode v2 (`src/components/consent/`): defaults are denied and registered in a `beforeInteractive` script before GTM loads, and the consent banner calls `gtag('consent', 'update', …)` on the user's choice. The app event contract is consent-agnostic; GTM decides whether GA4 and Meta tags fire once consent state is known. Confirm the GA4/Meta tags in the container respect the consent signals before publishing ad/analytics tags live.

## Official References

- Google Tag Manager API developer guide: https://developers.google.com/tag-platform/tag-manager/api/v2/devguide
- Google Tag Manager custom event trigger help: https://support.google.com/tagmanager/answer/7679219
- GA4 recommended ecommerce events: https://developers.google.com/analytics/devguides/collection/ga4/reference/events
- Meta Pixel standard events: https://developers.facebook.com/docs/meta-pixel/reference#standard-events

## Server-side Conversions

The Stripe webhook fires `Purchase` (Meta CAPI) and `purchase` (GA4 Measurement Protocol) on a newly-paid order, deduplicated by the PaymentIntent ID:

- **Meta CAPI event_id**: `purchase-<payment_intent_id>` — matches the browser `event_id` emitted at order confirmation, so Meta deduplicates the pixel event and the server event into one.
- **GA4 transaction_id**: `<payment_intent_id>` — same value used in the browser `purchase` event.
- **Consent gate**: both calls are skipped when `orders.marketing.consent !== 'granted'` (captured from the buyer's cookie state at checkout time).
- **PII hashing**: email, phone, name, address fields are SHA-256 hashed per Meta spec before transmission.
- **App version**: the GA4 MP `purchase` event also includes `app_version`/`app_git_sha`, threaded through `ConversionsDeps` from the same `NEXT_PUBLIC_APP_VERSION`/`NEXT_PUBLIC_GIT_SHA` build-time constants as the client-side events.

New runtime secrets required:

| Secret | How to set | Description |
|--------|-----------|-------------|
| `META_CAPI_ACCESS_TOKEN` | `wrangler secret put META_CAPI_ACCESS_TOKEN` | Meta system-user token with `ads_management` + CAPI scope |
| `GA4_API_SECRET` | `wrangler secret put GA4_API_SECRET` | GA4 Admin → Data Streams → Measurement Protocol API secrets |
| `META_TEST_EVENT_CODE` | `wrangler secret put META_TEST_EVENT_CODE` | Optional; set during validation only, remove before going live |

### Diagnosing Meta CAPI failures

`meta capi purchase http error <status>` in Sentry means the webhook's server-side Purchase call to
Meta's Graph API failed — `extra.response_body` on that Sentry event has Meta's exact error message.
To check *why* directly against the Graph API (credentials mismatch vs. a bad payload vs. a transient
Meta-side error), use `scripts/debug-meta-capi.mjs`:

```bash
# Check the values currently in .dev.vars / .env.local:
npm run debug:meta-capi

# Check the values actually deployed on the Worker (wrangler secret values can't be
# read back — you need the token from wherever you generated/stored it):
META_CAPI_ACCESS_TOKEN=<prod token> npm run debug:meta-capi -- --pixel-id <prod NEXT_PUBLIC_META_PIXEL_ID>

# Also fire one real diagnostic event (requires a Test Events code — never sends live):
npm run debug:meta-capi -- --send --test-event-code <code from Events Manager>
```

Prefer the `META_CAPI_ACCESS_TOKEN` env var over `--token` — CLI arguments land in shell history and are
visible to `ps` while the process runs. The script prints an explicit verdict (invalid token / credentials
mismatch / payload rejected / inconclusive) rather than treating every failure as a credentials problem.

## Microsoft Clarity (heatmaps / session recordings)

Clarity is added **through GTM**, not in app code, so it stays consent-gated alongside GA4/Meta.
Clarity natively honors Google Consent Mode v2 (`analytics_storage` / `ad_storage`), which the app
already drives via `src/components/consent/`. EEA/UK/CH consent enforcement is live (since 2025-10-31),
so gating is mandatory.

1. Create a Clarity project → copy the **Project ID**.
2. Clarity → **Settings → Setup → Advanced → Cookies = OFF** so `_clck` / `_clsk` are only set after consent.
3. GTM → add the official **Microsoft Clarity** tag template (Template Gallery), set the Project ID,
   trigger **All Pages**, and add a **Consent check requiring `analytics_storage`** on the tag.
4. Re-export the updated container to `docs/GTM-NPHLG9NR_v*.json` (keep the repo as the source of truth).
5. Verify in DevTools → Application → Cookies: `_clck` / `_clsk` appear **only after Accept**, absent after Reject.

## Search Console & Bing (verification — no tracking tag)

Verify by **DNS domain property** (covers all subdomains + http/https), not an HTML/tracking tag:

1. **Google Search Console** → add property **Domain** (`anna-ciok.studio`) → copy the
   `google-site-verification=…` TXT record → add it at **OVH DNS** (alongside the existing DMARC record) → Verify.
2. **Bing Webmaster Tools** → add site → **Import from Google Search Console** (zero extra config).
3. Submit the sitemap in both: `https://anna-ciok.studio/sitemap.xml` (generated by `src/app/sitemap.ts`).

A code-based fallback exists if DNS is ever impractical: Next.js `metadata.verification` in
`src/app/[locale]/layout.tsx` (`verification: { google, other: { 'msvalidate.01': … } }`). DNS is preferred.
