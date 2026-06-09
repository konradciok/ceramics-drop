# Server-side conversions (Meta CAPI + GA4 MP) + EMQ + consent gating

**Date:** 2026-06-09
**Status:** Approved design — pending implementation plan

## Problem

`purchase` fires **only** client-side on `/koszyk/return`. That page is reached only
if the browser returns from Stripe and survives ITP/Safari, ad-blockers, and consent
denial — a realistic 20–40% conversion-signal loss on iOS/Safari traffic. Meanwhile the
Stripe webhook (`handleStripeEvent → markPaid`) is the guaranteed server-side truth for a
paid order. We also leave match quality on the table (no hashed user data, no `contents[]`),
and the Meta Pixel currently fires with **no consent gating** — a live GDPR gap for an
EU/PL default-denied storefront.

## Goals

1. Recover lost purchase conversions by sending **Meta CAPI** and **GA4 Measurement
   Protocol** `purchase` from the webhook, deduplicated against the browser events.
2. Maximise match quality: send full SHA-256-hashed buyer data + Meta identifiers.
3. Make consent authoritative end-to-end (server sends gated; browser Pixel gated in GTM).
4. Add browser-side EMQ wins: `contents[]` and (where achievable) Advanced Matching.

## Non-goals

- Server-side events other than `purchase` (begin_checkout etc. stay client-only —
  the webhook only knows about paid orders, so there is no clean abandoned-checkout signal).
- A queue/worker pipeline (YAGNI — CAPI/MP calls are fast; the existing best-effort +
  bounded-retry + Sentry pattern isolates failures).
- Server-side Advanced Matching for any event other than the existing order data.

## Prerequisite (already shipped)

Purchase `event_id` is deterministic: `purchase-${orderNo}` where `orderNo` defaults to the
PaymentIntent id. The browser event and the server CAPI event therefore reconstruct the same
id from `pi.id`, which is what makes Meta browser↔server dedup work. (`src/lib/analytics.ts`,
test in `src/lib/analytics.test.ts`.)

## Architecture (Approach 1: DB-backed marketing context + webhook orchestrator)

Capture cookie/header context at the checkout POST, persist on the order, then have a new
webhook dep load it, gate on consent, hash, and send to both channels via plain `fetch`.

### 1. Data model — one migration

New nullable `jsonb` column `orders.marketing` (jsonb matches the existing `shipping_address`
pattern), written once at checkout:

```jsonc
{
  "consent":          "granted" | "denied",  // from ciok_consent cookie, server-side
  "fbp":              string | null,          // _fbp cookie (forwarded by client)
  "fbc":              string | null,          // _fbc cookie / derived from fbclid
  "ga_client_id":     string | null,          // from _ga cookie (forwarded by client)
  "ga_session_id":    string | null,          // from _ga_<id> cookie
  "ip":               string | null,          // getClientIp() server-side
  "user_agent":       string | null,          // request header
  "event_source_url": string | null,          // referer / canonical return URL
  "captured_at":      string                  // ISO timestamp
}
```

One grouped column keeps match identifiers GDPR-purgeable in one place and avoids schema
churn. Migration lives in `supabase/migrations/<timestamp>_orders_marketing.sql`. Applied to
prod (`wnlysejenowymjdxlnaq`) via the Supabase MCP `apply_migration` after spec approval; the
separate dev Supabase gets the same migration.

### 2. Capture at checkout

`POST /api/checkout` already has the client IP (`getClientIp`) and can read request headers +
the `ciok_consent` cookie. A small client helper reads the JS-readable cookies
(`_fbp`, `_fbc`, `_ga`/`_ga_*`) and adds them to the existing checkout POST body. The route
assembles the `marketing` object and stores it on the `orders` insert. No new endpoint.

### 3. New modules — `src/lib/marketing/`

- `hash.ts` — Meta-spec normalization (email: trim+lowercase; phone: digits E.164;
  name/city/postal: trim+lowercase; country: 2-letter lowercase) + SHA-256 hex via Web Crypto
  (`crypto.subtle`, available on Workers). Pure, fully unit-tested.
- `meta-capi.ts` — builds + POSTs the Graph API `/<PIXEL_ID>/events` payload (raw `fetch`).
- `ga4-mp.ts` — builds + POSTs the GA4 `/mp/collect` payload (raw `fetch`).
- `conversions.ts` — orchestrator: load order + items + `marketing`, gate on
  `consent === 'granted'`, hash PII, fire both channels independently (best-effort).

### 4. Webhook wiring

Add `trackPurchase(pi)` to `WebhookDeps`. Called in `handleStripeEvent` on
`payment_intent.succeeded` **only when `markPaid` returned `newSale`** (mirrors the
studio-email gating so retried/duplicate deliveries do not double-fire). The route
implements it via `conversions.ts`.

### 5. Dedup keys

- **Meta:** `event_id = "purchase-" + pi.id`, `event_name = "Purchase"`,
  `action_source = "website"`. Dedups against the browser Pixel event.
- **GA4:** `transaction_id = pi.id`. GA4 dedups purchases by `transaction_id`. If
  `ga_client_id` is missing, **skip GA4 MP** (required for attribution) and log — never
  fabricate one.
- Values in **major units** (PLN = `total / 100`); currency `PLN`.

### 6. Consent gating — server + browser

- **Server:** orchestrator sends nothing unless stored `consent === 'granted'`.
- **Browser (GTM, `scripts/gtm-api.mjs`):** add `consentSettings` so the Meta Pixel base +
  Meta bridge require `ad_storage` granted, and the GA4 tags require `analytics_storage`.
  Closes the gap where the Pixel fires regardless of consent. Re-publish via
  `npm run gtm:setup -- --publish`.

### 7. Browser EMQ additions

- **`contents:[{id, quantity, item_price}]`** added to the Meta payload in `analytics.ts` and
  passed through the Meta bridge (Meta-only; GA4 keeps `items[]`). Reliable win.
- **Advanced Matching:** attaches only at `begin_checkout`, where the email is known
  client-side (the return page has only the PI, not the email). Hash email client-side, push
  as `user_data`; bridges apply via fbq Advanced Matching + GA4 `set user_data`. Modest value
  — for the Purchase event, the **server** CAPI hashed email is the real match driver.

### 8. Error handling

Best-effort, like `ensureInvoiced`: a few bounded retries, then swallow + `console.error` +
Sentry capture, returning 200 to Stripe (an analytics failure must not trigger a full webhook
retry of markPaid/shipment). Each channel fails independently.

### 9. Secrets / env

New runtime secrets: `META_CAPI_ACCESS_TOKEN`, `GA4_API_SECRET`, optional
`META_TEST_EVENT_CODE`. Reuse existing public IDs server-side (`NEXT_PUBLIC_META_PIXEL_ID`,
`NEXT_PUBLIC_GA4_MEASUREMENT_ID`). Add to `.env.example` + `.dev.vars`; set prod via
`wrangler secret put`.

### 10. Testing

- `hash.test.ts` — normalization vectors against Meta's documented examples.
- `meta-capi.test.ts` / `ga4-mp.test.ts` — payload shape with `fetch` mocked (dedup id,
  major-unit values, hashed fields present, no plaintext PII in body).
- `conversions.test.ts` — consent denied → no send; missing `ga_client_id` → GA4 skipped;
  granted → both fire.
- `webhook.test.ts` — extend: `trackPurchase` fires only on `newSale`.
- Manual: Meta **Test Events** (`test_event_code`) + GA4 **DebugView** before go-live.

### 11. Rollout

Migration (prod + dev) → deploy code with secrets → GTM re-publish with consent gating →
verify Meta Events Manager (EMQ score, dedup "received from browser and server") and GA4
DebugView → confirm no double-count.

## Data flow

```
checkout POST ──> capture {consent, fbp, fbc, ga_client_id, ga_session_id, ip, ua}
              └─> orders.marketing (jsonb)

Stripe payment_intent.succeeded
  └─> markPaid (newSale?) ──true──> trackPurchase(pi)
          └─> conversions.ts: load order+items+marketing
                ├─ consent !== 'granted' ──> skip (log)
                └─ consent === 'granted'
                     ├─ meta-capi.send()  (event_id = purchase-<pi>)
                     └─ ga4-mp.send()      (transaction_id = <pi>, needs ga_client_id)
```

## References

- Meta Conversions API: https://developers.facebook.com/docs/marketing-api/conversions-api
- Meta event dedup: https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events
- GA4 Measurement Protocol: https://developers.google.com/analytics/devguides/collection/protocol/ga4
- GTM consent settings (API): https://developers.google.com/tag-platform/tag-manager/api/v2/reference/accounts/containers/workspaces/tags
