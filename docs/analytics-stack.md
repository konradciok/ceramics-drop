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
| `site_engagement` | scroll depth, 30s time, language switch, contact submit, cart CTA/clear, plus the custom events below | engagement reporting | `SiteEngagement` custom event |

`consent_update` is a GTM-internal signal only — pushed by `setConsent()` in `src/components/consent/consent-mode.ts` right after its `gtag('consent','update',...)` call, so GTM's `ACC - Consent Update` trigger can give the two base tags (and Microsoft Clarity) a fresh chance to fire if a visitor accepts consent mid-session rather than arriving with it already granted. Deliberately excluded from `ANALYTICS_EVENTS`, so it's never forwarded to GA4/Meta as a fake event.

All custom events ride the single `site_engagement` dataLayer event, distinguished by the `engagement_type` parameter (built by `buildEngagementEvent(type, props)` in `src/lib/analytics.ts`). The GTM container already forwards `site_engagement` generically, so these reach GA4 with **no per-event tag** — register `engagement_type` (and any new param) as GA4 custom dimensions to report on them.

| `engagement_type` | When | Extra params |
| --- | --- | --- |
| `language_change` | PL/EN/ES switch | `from_locale`, `to_locale`, `page_path` |
| `parcel_locker_select` | buyer picks the InPost Paczkomat delivery method | `method`, `page` |
| `courier_select` | buyer picks courier delivery | `method`, `page` |
| `pickup_select` | buyer picks free Warsaw studio pickup | `method`, `page` |
| `parcel_locker_point_selected` | buyer completes InPost locker selection in the Geowidget | `locker_name` |
| `sold_item_view` | buyer clicks an already-sold tile (demand signal for drops) | `item_id`, `item_name`, `item_category`, `price` |
| `shop_filter` | buyer narrows the shop view via the status filter (sold/available) | `filter_status` (`all` \| `available` \| `sold`) |
| `checkout_error` | pre-payment `/api/checkout` failure | `reason` (`sold_out` \| `rate_limited` \| `checkout_failed` \| `network_error` \| `response_parse_error` \| `order_conflict` \| `checkout_in_progress`), `status`, `sold_count` |
| `payment_failed` | Stripe PaymentIntent failed/canceled on `/koszyk/return` | `status` (PaymentIntent status; the PI id is never sent). Deduped once per PaymentIntent via `pushPaymentFailedOnce` so refresh / Strict-Mode double-mount doesn't inflate counts. The `status` param preserves granularity (e.g. `canceled` vs. `requires_payment_method`). |

GA4 ecommerce payloads use:

- `currency: "PLN"`
- `ecommerce.value`: item subtotal
- `ecommerce.shipping`: shipping cost on purchase
- `order_total`: subtotal plus shipping as a custom parameter
- `transaction_id`: order number for `purchase`
- `items[]`: `item_id`, `item_name`, `item_brand`, `item_category`, `item_variant`, `price`, `quantity`

Meta payloads use standard event names where available and include `event_id` for future browser/server deduplication.

Every event also carries `app_version` (semver from `package.json`) and `app_git_sha` (short git SHA, or `"dev"` for builds without git), stamped by `pushDataLayer()` in `src/lib/analytics.ts` from `NEXT_PUBLIC_APP_VERSION`/`NEXT_PUBLIC_GIT_SHA` (`next.config.ts`) — the same build-time constants already used for the Sentry release and the admin footer badge. The GTM bridge forwards them to GA4 generically like any other param; register them as GA4 custom dimensions to use them in Explore/reports (see the `engagement_type` note above).

## Google Cloud and GTM API Auth

The GTM scripts authenticate with the **bloomy-tale** deploy service account:

- Project: `bloomy-tale-477216`
- Service account: `gtm-api-deploy@bloomy-tale-477216.iam.gserviceaccount.com`
- Local key file: `.secrets/gtm-api-deploy.json` (gitignored)

One-time setup:

```bash
gcloud config set project bloomy-tale-477216
gcloud services enable tagmanager.googleapis.com --project bloomy-tale-477216
npm run gtm:key
```

The service account must have access to the GTM container. Grant that in GCP / Google Marketing Platform for the bloomy-tale project, or via an admin who can attach the service account to the GTM account programmatically. The GTM **User management** UI only accepts human Google accounts, not `@iam.gserviceaccount.com` emails.

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

**Consent-update re-fire fixed 2026-07-27** (`docs/superpowers/specs/2026-07-27-gtm-consent-refire-design.md`): GTM's Additional Consent Checks only gate a tag at the moment its own trigger fires — a visitor who accepted the cookie banner mid-session (rather than arriving with consent already granted) got no tracking at all for that session, since `ACC - GA4 base`/`ACC - Meta Pixel base` fired on a one-shot `Initialization` trigger and Clarity had the same shape of gap. Added the `ACC - Consent Update` trigger (matching the new `consent_update` dataLayer event from `setConsent()`) as a second firing trigger on all three tags and republished as version 13; current export is `docs/GTM-NPHLG9NR_v13.json`. **Not verified in GTM Preview before publishing** (Claude in Chrome extension was unavailable; published on explicit user decision) — the community-reported "once per page consumes the firing budget even when blocked" GTM quirk has not been empirically ruled out for the two base tags. If tracking still doesn't recover after a mid-session Accept, check that first.

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
