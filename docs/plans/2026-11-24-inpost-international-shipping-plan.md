# InPost lockers across Europe, shipped from Spain (via Sendcloud) — plan

Status: **approved 2026-11-24; PR 1 (carrier refactor) merged via #392; PR 2 (order columns) merged via #393; PR 3 (Sendcloud adapter) in progress**.
Branch: `claude/inpost-spain-international-cec596`.

## Goal

Every ceramic order ships **from mainland Spain**. The studio drops each parcel
at an InPost Spain locker or Punto Pack point, and the customer collects it from
an InPost locker or pickup point in one of ten countries. The PL-only ShipX
integration becomes one adapter in a carrier layer. New orders go through
**Sendcloud** (API v3); ShipX stays only for orders created before the cutover.

## 0. Owner decisions (2026-11-24)

| # | Decision |
|---|---|
| 1 | Launch **every country** InPost serves from Spain to lockers/points: **ES, PT, FR, DE, AT, BE, NL, LU, IT, PL** (PL: see open decision A) |
| 2 | Locker price **Spain 10 €**, **every other country 15 €** (PLN/GBP figures: §5) |
| 3 | Delivery promise for Spain: **4 business days** |
| 4 | All parcels are handed over at an InPost locker/point **in mainland Spain**, including parcels to Poland |
| 5 | Integration through **Sendcloud**, which is InPost Spain's own route for shops under ~7,000 parcels/year |
| 6 | **Lockers / pickup points only**: the courier-to-address option leaves checkout |

**Still open:**
- **A. Poland lane.** Sendcloud's InPost ES conditions do not list Spain→Poland (§1), but InPost Spain sells that lane to consumers. First step: query `/shipping-options` ES→PL in the owner's Sendcloud account. If no option comes back, choose one of:
  - activate an **InPost Global** contract in Sendcloud (Sendcloud supports it as a separate contract carrier);
  - use another Sendcloud carrier for Poland;
  - launch without Poland.
- **B. Shipping protection.** Without it, the carrier pays at most **€25 per parcel**. Sendcloud's XCover protection costs 1.5 % of the insured value internationally and 0.6 % within Spain. It covers ceramics up to €1,000, but not chips or "works of art".
- **C.** PLN/GBP prices (§5) and the delivery time promised outside Spain (§8).

## 1. Research summary (verified 2026-11-24)

**Why not the current integration.** ShipX (`api-shipx-pl.easypack24.net`) is
InPost Poland's domestic API. Parcels must be handed over in Poland, and its
service catalogue has no international service. The InPost Global API
(`api.inpost-group.com`) documents only Poland as an origin. Neither fits a
sender in Spain.

**InPost Spain** (Mondial Relay S.A.S.U., Sucursal en España):
- Ships from Spain to lockers and Punto Pack points in PT, FR, DE, BE, LU, NL, PL and IT, as well as within Spain. GB is "not possible". (inpost.es/envia-con-nosotros/envios-internacionales)
- Does **not** serve Canarias, Andorra or Ceuta/Melilla. Balearics cost the same as mainland Spain. (inpost.es FAQ)
- Shops under ~7,000 parcels/year are sent to "InPost powered by Sendcloud" ("Oferta Start", lockers and Punto Pack only). (inpost.es/eres-empresa/envios-para-tu-negocio)
- Fragile tableware is "not prohibited", but InPost accepts no liability for breakage. (inpost.es FAQ)
- Average transit times: Spain ~3 days, PT/FR 2–4, other EU 3–5, **Poland 5–7**.
- Pickup windows: 5 days in most countries, 3 in Italy, 7 in Germany. In **Poland only 48 h** at the locker.

**Sendcloud** (support.sendcloud.com "InPost ES shipping conditions", updated 2026-11-19; sendcloud.dev):
- **Carrier and lanes.** The carrier code is `inpost_es`. Products:
  - "Punto de Servicio Nacional C2C": Spain→Spain, including the Balearics.
  - "Punto de Servicio Internacional C2C": Spain→**AT, BE, DE, FR, IT, LU, NL, PT**.
  - Each product has a **QR (label-less)** twin. **PL is not listed.**
- **Rates and drop-off.**
  - Sendcloud's pre-negotiated rates apply; no own InPost contract is needed.
  - Drop-off is at any Punto Pack or locker, up to 20 parcels per visit. Collection from the sender exists only in Madrid (postcodes 28…).
  - Indicative domestic label: €2.77–3.09 depending on plan. International rates appear only in the panel or `/shipping-options` quotes.
- **Limits via Sendcloud.**
  - Locker: 62×38×36 cm, 20 kg. Punto Pack: 30 kg, longest side 120 cm, L+W+H ≤ 150 cm.
  - A parcel too big for the locker is redirected to a Punto Pack.
  - Uncollected parcels go to Mondial Relay France and are destroyed after 14 more business days.
- **Liability and claims.**
  - Carrier liability is **€25 flat** per parcel. "Works of art" travel at the sender's risk.
  - Claims must be filed within 24 h for visible damage and 7 days for hidden damage.
- **Plans.**
  - API, service points and webhooks are available from the Free plan.
  - Free is pay-per-label. One page says it is capped at 20 parcels/month; to be confirmed.
  - Lite costs €28–35/month and includes 400 labels.
  - Branded tracking emails need Lite; a branded tracking page needs Growth.

## 2. Where the code is PL-only today

| Concern | Where | Today |
|---|---|---|
| Delivery validation | `src/lib/shipx.ts` `validateDelivery` | courier `country_code` defaults to `PL`; lockers carry no country |
| Checkout guard | `src/app/api/checkout/route.ts:145` | refuses any address with `country_code !== 'PL'` |
| Cart form | `src/components/shop/CartView.tsx:493-525`, `:876-1025` | locker + courier options, hard-coded `country_code: 'PL'`, `delivery.plOnly` note |
| Point picker | `src/components/shop/GeowidgetPicker.tsx` | InPost PL Geowidget v5, language pl/en only |
| Carrier client + payload | `src/lib/inpost.ts`, `src/lib/shipx.ts`, `src/lib/shipx-errors.ts` | ShipX only |
| Orchestration | `src/lib/shipment.ts` | ShipX create → dispatch → poll offers → buy |
| Status webhook | `src/app/api/inpost/webhook/route.ts` | ShipX payload; `confirmed` = label ready → studio label email + customer email |
| Rates | `src/lib/pricing.ts`, CMS `shipping_rates` resource `domestic` | one price per method × currency, no destination |
| Tracking link | `src/lib/tracking.ts` | `inpost.pl/sledzenie-przesylek` |
| Account / admin | `src/lib/account/status.ts`, `src/lib/admin/fulfillment.ts`, `src/app/admin/*` | ShipX status vocabulary, "Paczkomat <code>" |
| Emails | `src/lib/email.ts` (+ copy in `scripts/reconcile-orders.mjs`) | "all orders in Poland …" |
| JSON-LD | `src/lib/seo/structured-data.ts` | the `es`/`de`/`en` locales already claim shipping to ES/DE/GB at the domestic EUR rates, which is **inaccurate today** |
| Packing | `src/lib/packing.ts` | A/B/C plan with C = 41 cm high; Sendcloud's locker limit is 36 cm |
| CSP | `src/middleware.ts:93-97` | `geowidget.inpost.pl`, `api-shipx-pl.easypack24.net` |
| Copy (22 PL keys) | `messages/*.json` | "w całej Polsce", "czeka w Polsce", courier, Paczkomat |

PL copy keys that mention Poland, InPost or the courier:
- `account.methodPaczkomat`, `account.methodKurier`, `account.paczkomatLabel`
- `ship.paczkomatT`, `ship.courierT`
- `delivery.lockerChosen`, `delivery.chooseLocker`, `delivery.lockerUnavailable`, `delivery.plOnly`
- `home.craft3P`, `home.craft3HShipOnly`, `home.craft3PShipOnly`, `home.ctVShip`
- `studio.fact4D`
- `shipping.s1P`, `shipping.s1Li1`, `shipping.s1Li1b`, `shipping.s2P`
- `deliveryNotice.p1`, `deliveryNotice.p3`
- `printPdp.accordionShipping`, `ceramicShop.metaDescription`

Also affected: the terms page §4 and the email strings.

## 3. Target architecture

```
src/lib/delivery/                 # checkout domain, pure, no I/O
  destinations.ts                 # the ten countries: zone, Sendcloud carrier, transit days, defaults
  validate.ts                     # validateDelivery, moved from shipx.ts and made country-aware
  types.ts                        # DeliverySelection / DeliveryContact / DeliveryPoint
src/lib/carriers/
  types.ts                        # ShipmentCarrier interface, CarrierShipment, retryability
  index.ts                        # carrierForOrder(order), chosen by orders.shipping_channel
  inpost-shipx/                   # today's ShipX code, moved unchanged (legacy orders only)
    client.ts  payload.ts  webhook.ts  errors.ts
  sendcloud/                      # new
    client.ts  shipments.ts  service-points.ts  status-map.ts  webhook.ts
src/lib/shipment.ts               # carrier-agnostic orchestration (idempotency, persist, alerts)
src/app/api/sendcloud/webhook/route.ts   # signed parcel_status_changed callback
```

**Destination registry.** This is the only place a country is configured:

```ts
type Destination = {
  country: 'ES' | 'PT' | 'FR' | 'DE' | 'AT' | 'BE' | 'NL' | 'LU' | 'IT' | 'PL';
  enabled: boolean;
  zone: 'es' | 'eu';                        // price zone (decision 2)
  sendcloudCarrier: 'inpost_es' | 'inpost_global'; // PL may need inpost_global (decision A)
  transitDays: number;                      // copy + JSON-LD (ES 4; others per §8)
};
```

Default country at checkout: `CF-IPCountry` if it is in the registry. Otherwise `pl → PL`, `es → ES`, `de → DE`, `en → ES`.

**Carrier interface.** It hides the two shipment lifecycles:

```ts
// src/lib/carriers/types.ts (landed in PR 1; PR 3 adds 'sendcloud' and cancel)
interface ShipmentCarrier {
  channel: 'inpost_shipx' | 'sendcloud';
  /** Create the shipment, or adopt one a lost DB write left behind (adoptExisting: false = admin recreate). */
  create(order: OrderForShipment, opts: { adoptExisting: boolean }): Promise<CarrierShipment>;
  /** Every post-create step once the id is saved; idempotent, runs on each replay
   *  (ShipX: courier dispatch + buy the offer; Sendcloud: no-op). */
  complete(progress: ShipmentProgress, hooks: ShipmentHooks): Promise<void>;
  /** Cancel before re-creating (Sendcloud only; ShipX keeps today's manual path). */
  cancel?(shipmentId: string): Promise<void>;
  getLabelPdf(shipmentId: string): Promise<ArrayBuffer>;
  isRetryable(err: unknown): boolean;   // replaces shouldRethrowShipmentError at call sites
}
```

`createOrderShipment` keeps today's guarantees:
- idempotent on the saved shipment id;
- adopts an existing shipment after a lost DB write;
- never throws a non-retryable error into the Stripe webhook;
- sends a Sentry alert on orphaned shipments.

It asks `carrierForOrder` which adapter to use.

**Status vocabulary.** Sendcloud parcel statuses are mapped at ingest onto the status names the app already uses: `confirmed` (label ready), `dispatched_by_sender`, `ready_to_pickup`, `delivered`, `returned_to_sender`. The account page, the admin queue and the customer emails therefore keep one code path. The raw Sendcloud status id and message are logged.

### 3.1 Sendcloud integration (API v3)

**Base and auth.**
- Base URL: `https://panel.sendcloud.sc/api/v3`.
- HTTP Basic auth: public key as username, secret key as password.
- API **v3 only**: v2 "create parcel" is closed to accounts created after April 2026.
- Rate limits: 100 POST/min, 1,000 GET/min.

**Lane check and quote.**
- `POST /shipping-options` with:
  - `from_address` (the sender address);
  - `to_address.country_code`;
  - `to_service_point.id`;
  - `parcels[].weight` / `dimensions`;
  - `carrier_code`;
  - `calculate_quotes: true`.
- It returns the `shipping_option_code` and its `requirements`.
- Used once per country to confirm the lane (decision A). At runtime it is used either to pick the code, or a per-country code is stored in config after verification.

**Create.** `POST /shipments/announce` (synchronous):
- `from_address: {sender_address_id}`.
- `to_address`: name, point address, `country_code`, `email`, `phone_number`.
- `to_service_point: {id}`.
- `ship_with: {type: "shipping_option_code", properties: {shipping_option_code}}`.
- One parcel with weight and dimensions from `packing.ts`.
- `order_number` = `orders.id`; `external_reference_id` = `orders.id:<shipment_attempt>` (see Idempotency).
- `total_order_price`, and optionally `additional_insured_price` (decision B).

**Idempotency.** `external_reference_id` must be unique. A repeat create answers **409 with the existing shipment**, so a replay adopts the existing shipment instead of creating a second one. `GET /shipments?external_reference_id=` also finds it.

The reference is `orders.id:<orders.shipment_attempt>`, not the bare order id. The docs do not say that a cancelled shipment frees its reference, so a bare `orders.id` would make the admin recreate (§7) get the cancelled shipment back through the 409.
- Retries and webhook replays reuse the persisted attempt, so they adopt the same shipment.
- Only a deliberate recreate advances the attempt. This is the Sendcloud counterpart of ShipX's `adoptExisting: false`.
- To verify on a real account: whether a reference is reusable after cancel. If it is, the attempt counter is harmless.

**Label.**
- For a single-parcel shipment, the create response already holds `parcels[].label_file` (base64 PDF).
- To fetch it again: `GET /parcels/{id}/documents/label?paper_size=A6`.
- Labels are valid for 30 business days.
- The QR (label-less) variant is a different `shipping_option_code`. How the QR reaches us must be tested with a real shipment.

**Cancel.**
- Endpoint: `POST /shipments/{id}/cancel`.
- Free until 23:59 on the creation day; credited within 42 business days.
- Used by the admin "create a new shipment" button.

**Webhook.**
- Event: `parcel_status_changed`. Header `Sendcloud-Signature` = hex HMAC-SHA256 of the raw body, keyed with a dedicated Webhook Signature Key.
- The endpoint must answer **2xx within 10 s**.
- Retries: 10 attempts over ~1.5 h on timeouts and on 406/408/409/429/5xx. Any other 4xx stops retries.
- Events can arrive out of order, so they are applied by `timestamp`.
- The payload carries `parcel.id`, `tracking_number`, `tracking_url`, `status{id,message}` and `order_number`.
- Real status ids come from `GET /parcels/statuses` (v3), not from memory.

**Service points.**
- Hosted picker `https://embed.sendcloud.sc/spp/1.0.0/api.min.js`, called as `sendcloud.servicePoints.open(config, onSuccess, onFailure)`.
- Config:
  - `apiKey` = the public key (browser-safe);
  - `country`, `postalCode`;
  - `carriers` (InPost only);
  - `language`.
- Languages: de-de, en-gb, en-us, es-es, fr-fr, it-it, nl-nl. **There is no Polish**: the `pl` locale gets `en-gb`.
- The success callback returns the point: `id` (Sendcloud id, used for the shipment), `code` (carrier id), `name`, `street`, `house_number`, `postal_code`, `city`, `country`, `shop_type`.
- Server-side check before the PaymentIntent: `GET /service-points/{id}` and `POST /service-points/{id}/check-availability`, both with secret credentials.
- To verify per country: that `inpost_es` returns InPost lockers and Mondial Relay points in all ten countries, and what the picker's `carriers` filter expects.

**Test labels.** `shipping_option_code: "sendcloud:letter"` creates free test shipments for CI-like runs against the real API.

## 4. Data model (one additive migration)

- `orders.delivery_country text` (ISO 3166-1 alpha-2). Backfill `'PL'` for every order with `delivery_method in ('paczkomat','kurier')`.
- `orders.shipping_channel text check (shipping_channel in ('inpost_shipx','sendcloud'))`. Backfill `'inpost_shipx'` for the same rows. New orders write `'sendcloud'`.
- `orders.delivery_point jsonb`: the chosen point as shown to the customer (`id`, `code`, `carrier`, `name`, `street`, `house_number`, `post_code`, `city`, `country`). Read by the emails, the account page and the admin.
- `orders.tracking_url text`: the tracking link Sendcloud returns, validated with `httpsUrlOrNull` (`src/lib/tracking.ts`).
- `orders.shipment_attempt integer not null default 0`: the suffix of the Sendcloud `external_reference_id` (§3.1). It is advanced only by the admin recreate, in the same update that clears the old shipment columns.
- The `inpost_*` columns are reused, because the parcel is still InPost's:
  - `inpost_shipment_id` = Sendcloud **shipment** id (what `GET /shipments/{id}` and cancel take; the label is fetched through its first parcel);
  - `inpost_tracking_number` = carrier tracking number;
  - `inpost_target_point` = point code.
- Sendcloud webhooks are matched by `order_number` (= `orders.id`, the primary key) plus `shipping_channel = 'sendcloud'`, not by shipment id. An update whose tracking number differs from the order's belongs to a superseded shipment (admin recreate) and is ignored. Sendcloud shipment ids are strings, so they never collide with ShipX's numeric ids in the ShipX webhook lookup.
- `create or replace function prepare_balance_order(...)` so that gift-card-balance orders persist the new columns (the function lists its insert columns explicitly).
- Migrations apply to prod on merge (Supabase GitHub integration), so back up first.

## 5. Rates

- New CMS `shipping_rates` resource **`lockers`**: two zones × three currencies = 6 fields. Proposed seed (decision C). Repo rule: each currency is set independently and never FX-derived at runtime.

  | Zone | EUR | PLN | GBP |
  |---|---|---|---|
  | `es` (Spain) | 10 | 43 | 9 |
  | `eu` (PT, FR, DE, AT, BE, NL, LU, IT, PL) | 15 | 65 | 13 |

- Code fallback `DEFAULT_LOCKER_SHIPPING` in `pricing.ts`, wired into the same last-known-good ladder. Seed and lockstep test in `shipping-rates-mapping.test.ts`.
- `getShippingRatesForDisplay()` / `getShippingRatesForCheckout()` gain a `(country, currency)` lookup. `display-parity.test.ts` covers the new surfaces.
- The `domestic` (PL) and `international` (Prodigi) resources become dormant. They stay untouched here and are removed in a later cleanup together with the cms-ceramics client.
- The PDP and /dostawa-i-zwroty show "10 €" (Spain) and "15 €" (other countries).

## 6. Checkout

- **Methods.** `CHECKOUT_DELIVERY_METHODS = ['paczkomat']`.
  - `kurier`, like `odbior`, stays a `DeliveryMethod` for historical orders and the admin.
  - `validateDelivery` refuses it (`invalid_method`).
  - The cart drops the method radio and the address form.
- **Country select** ("Kraj dostawy") at the top of Delivery. It lists the enabled countries, defaults as in §3, and is persisted in localStorage.
- **Point picker.**
  - The Sendcloud picker for the chosen country replaces `GeowidgetPicker`: one widget for all countries, InPost lockers and Punto Pack only.
  - The selected point must belong to the chosen country.
  - Picker unavailable (script blocked or slow): keep today's fallback message and block payment, as `geowidget-unavailable.spec.ts` covers now.
- **Contact.** First/last name, email and phone. The phone is required, because InPost sends the pickup code by SMS/email and charges €1 for a missing phone. It is normalised to E.164, with the country's prefix shown as a hint.
- **Server.**
  - `validateDelivery` takes `delivery_country` and the point.
  - The hard `country_code !== 'PL'` guard goes.
  - The point is re-checked against the Sendcloud service-point API (exists, InPost, same country, available) before the PaymentIntent is created.
  - The rate comes from the country's zone.
- **Packing.**
  - Sendcloud needs weight and dimensions. `src/lib/packing.ts` already estimates a package plan per order.
  - Its locker limits change to 62×38×36 cm and 20 kg. A larger box still ships, because InPost redirects it to a Punto Pack.
  - An order that needs more than one box is held for a manual split. Shipment creation stops and alerts the studio.

## 7. Fulfilment

- **Create.** The Stripe webhook, the admin "create shipment" button and `npm run orders -- order create-shipment` all go through `createOrderShipment` → `carrierForOrder`.
- **Label.** Taken from the create response and emailed to the studio straight away; today ShipX waits for the `confirmed` webhook. The admin label route asks the carrier.
- **Status.**
  - The signed Sendcloud webhook route updates `delivery_status`, tracking and `tracking_url`, and sends the customer shipping email once.
  - Sendcloud stops retrying after ~1.5 h, so a **4th sweep** in the existing 15-min cron (`worker.ts`) polls open Sendcloud parcels as a backstop.
- **Recreate.** The admin button cancels the old Sendcloud shipment (`/shipments/{id}/cancel`) and advances `orders.shipment_attempt` before creating a new one. The new create therefore uses a fresh `external_reference_id` and cannot get the cancelled shipment back through the 409.
- **ShipX after cutover.**
  - No new ShipX shipments.
  - `/api/inpost/webhook`, the ShipX label route and the reconcile script keep serving orders created before the cutover.
  - ShipX is removed in a later cleanup, once no ShipX order is open.
- **Tracking links** come from `tracking_url`, with the carrier's site per country as fallback.

## 8. Copy and SEO (owner approval, `docs/copy-source-of-truth.md`)

Drafted in PL first, approved, then translated (en/es/de):
- **Shipping now from Spain.** "Ceramika jest gotowa i czeka w Polsce" becomes "… w Hiszpanii". "w całej Polsce" becomes the list of countries.
- **Lockers only.** Every courier mention goes (`ship.courierT`, `shipping.s1Li1b`, …).
- **Delivery time.**
  - Spain: **up to 4 business days** (decision 3).
  - Outside Spain: InPost quotes 3–5 days, Poland 5–7. Proposed: "do 7 dni roboczych" (decision C).
  - Fulfilment stays "do 2 dni roboczych".
- **Poland pickup window.** It is only 48 h, so the PL shipping email gets one line about it.
- **Canarias and other countries:** "napisz do mnie".
- **JSON-LD `shippingDetails`:** one entry per destination with its real rate and transit time. This fixes today's inaccurate ES/DE/GB claims.
- **Emails:** `deliveryP1/P3` in `src/lib/email.ts` and the copy inside `scripts/reconcile-orders.mjs`.

## 9. Config, env, CSP

- Runtime secrets:
  - `SENDCLOUD_PUBLIC_KEY` and `SENDCLOUD_SECRET_KEY` (API Basic auth);
  - `SENDCLOUD_WEBHOOK_SIGNATURE_KEY` (its own key, never the API secret).
- Var: `SENDCLOUD_SENDER_ADDRESS_ID`.
- Build-time: `NEXT_PUBLIC_SENDCLOUD_PUBLIC_KEY` for the picker. The public key is browser-safe by Sendcloud's design.
- All of the above go in `.env.example` (`env-example-completeness.test.ts`).
- CSP: `https://embed.sendcloud.sc` in `script-src` and `frame-src`. The API is called server-side only.
- `scripts/prod-target.json`: expected Sendcloud API host.

## 10. Tests

- **Unit:**
  - destination registry and defaults;
  - `validateDelivery` matrix (kurier refused, country/point mismatch);
  - Sendcloud shipment payload, 409-adopt path, status map;
  - webhook signature check and out-of-order events;
  - orchestration with fake carriers (create, replay, non-retryable);
  - zone rate lookups and lockstep.
- **Existing ShipX tests** move with the code in PR 1 and must pass unchanged.
- **E2E `@ci`:** locker purchase for ES and DE (and PL once decision A is settled), with a stubbed `sendcloud.servicePoints` (same pattern as `e2e/helpers/checkout.ts`). **`@checkout-edge`:** the real picker.
- **Manual, before checkout switches over:**
  - `sendcloud:letter` test shipments against the real API;
  - one real InPost parcel ES→ES and one to another country (create, label, drop-off, status updates).

## 11. Delivery plan (PRs)

1. **`refactor:` carrier layer, no behaviour change.**
   - Split `shipx.ts` into `delivery/` and `carriers/inpost-shipx/`.
   - Introduce `ShipmentCarrier` and make `createOrderShipment` carrier-agnostic.
   - Can start now.
2. **`feat:` new order columns, expand-only migration.**
   - New columns: `delivery_country` / `shipping_channel` / `delivery_point` / `tracking_url` / `shipment_attempt`, plus `prepare_balance_order` reading the checkout-time ones.
   - Existing ShipX orders are backfilled (`PL`, `inpost_shipx`).
   - **No code writes them in this release.** Workers Builds and the Supabase integration deploy independently on merge, so code that writes a column must ship after the column is live.
3. **`feat:` destination registry + Sendcloud adapter.**
   - Destination registry (`src/lib/delivery/destinations.ts`), plus checkout writing `delivery_country` / `shipping_channel` (PL + ShipX until PR 4).
   - Client, create/adopt, label, cancel, webhook, cron backstop, status map, admin/CLI.
   - No new index: Sendcloud updates are found by primary key (`order_number`).
   - Every lane's `sendcloudShippingOption` stays `null` (fail closed, non-retryable) until the lane check on the owner's account fills it in.
   - Not reachable from checkout yet. Tested with `sendcloud:letter` against the owner's account.
   - Lane check per country (decision A).
4. **`feat:` checkout from Spain.**
   - `lockers` rates resource, country select, Sendcloud picker, courier removed, CSP, JSON-LD.
   - New orders go to Sendcloud.
5. **`feat:` copy** in all locales, after PL approval. It can merge with PR 4 if approved in time.
6. **Later cleanup.** Remove ShipX and the PL Geowidget once no ShipX order is open, and retire the dormant `domestic` / `international` rate resources.

PRs 3–4 need the owner's Sendcloud account (§13).

## 12. Risks

- **Breakage is effectively uninsured by default.**
  - Carrier liability is €25 per parcel, and InPost refuses liability for fragile goods.
  - Sendcloud's generic claims list excludes ceramics; XCover covers them only up to €1,000 and excludes chips and "works of art".
  - Packing quality is the real protection. XCover's fragile-packing rule is box-in-box with 15 cm of cushioning.
- **Poland lane** may be missing from Sendcloud's InPost ES product (decision A).
- **Margin.** 15 € outside Spain. InPost's retail price to Poland is 12.65 € (≤1 kg) to 15.53 € (3–5 kg). Sendcloud's international quotes must be checked per weight.
- **Poland customer experience.** A 48 h locker pickup window and 5–7 days transit, against 20 zł and ≤5 days today.
- **No Polish in the picker** (English for `pl`). Fix later with an own picker on the service-points API if needed.
- **VAT.** B2C distance sales from Spain to other EU countries above €10,000 a year in total need OSS registration and destination-country VAT. Check with the accountant.
- **Cutover.** Orders paid before the switch still ship via ShipX from Poland. Check that no stock is left in Poland, or ship those orders by hand.

## 13. Owner set-up checklist (Sendcloud panel)

1. Account with a Spanish billing address. Add the **sender address in mainland Spain** and note its `sender_address_id`. Add a payment method.
2. Plan: Free to start; check the 20-parcels/month cap. Lite if tracking emails or an own InPost contract are wanted.
3. Shipping → Carriers: enable **InPost ES** (Sendcloud rates; no own contract needed).
4. Settings → Integrations: create a "Sendcloud API" integration. Put both keys in via `wrangler secret put`, and the public key also as the `NEXT_PUBLIC_SENDCLOUD_PUBLIC_KEY` Workers Build variable.
5. In that integration:
   - enable service points, InPost ES only;
   - enable webhook feedback with URL `https://anna-ciok.studio/api/sendcloud/webhook`;
   - set a Webhook Signature Key (≥16 characters, mixed);
   - press Test.
6. Decide B (shipping protection) and confirm C (PLN/GBP prices, delivery time outside Spain).
7. Ask Sendcloud support in writing whether handmade one-of-a-kind ceramics count as "works of art".
