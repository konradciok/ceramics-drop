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
| `site_engagement` | scroll depth, 30s time, language switch, contact submit, cart CTA/clear | engagement reporting | `SiteEngagement` custom event |

GA4 ecommerce payloads use:

- `currency: "EUR"`
- `ecommerce.value`: item subtotal
- `ecommerce.shipping`: shipping cost on purchase
- `order_total`: subtotal plus shipping as a custom parameter
- `transaction_id`: order number for `purchase`
- `items[]`: `item_id`, `item_name`, `item_brand`, `item_category`, `item_variant`, `price`, `quantity`

Meta payloads use standard event names where available and include `event_id` for future browser/server deduplication.

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

For production in the EU, connect this GTM workspace to a consent-management setup before publishing ad/analytics tags live. The app event contract is consent-agnostic; GTM should decide whether GA4 and Meta tags can fire after consent state is known.

## Official References

- Google Tag Manager API developer guide: https://developers.google.com/tag-platform/tag-manager/api/v2/devguide
- Google Tag Manager custom event trigger help: https://support.google.com/tagmanager/answer/7679219
- GA4 recommended ecommerce events: https://developers.google.com/analytics/devguides/collection/ga4/reference/events
- Meta Pixel standard events: https://developers.facebook.com/docs/meta-pixel/reference#standard-events
