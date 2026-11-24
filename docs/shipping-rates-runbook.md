# Shipping rates runbook

How a change to shipping rates reaches the storefront, and what to check after
publishing one.

## Where the rates live

The live CMS resource (served by the `CmsApi` entrypoint, `/v1/shipping-rates`):

| Resource id | Track | Shape |
|---|---|---|
| `domestic` | ceramics (InPost) | per currency (PLN / EUR / GBP) × `paczkomat` / `kurier` / `odbior` |
| `lockers` | ceramics shipped from Spain (InPost lockers / points) | price zone `es` (Spain) / `eu` (every other destination, Poland included) × PLN / EUR / GBP. Seeded 2026-11-24 (`20261124180000`) and **not read by the storefront yet**: the code that switches checkout and display onto it ships separately. Until then `domestic` stays live; keep the `eu` zone equal to the `domestic` paczkomat rates. |

The print-only `international` resource (Prodigi, per destination country) is
**dormant**: fine-art prints moved to https://anna-ciok.com on 2026-11-22 and
nothing in this store displays or charges it any more, but the resource (and
its validation/mapping in `src/server/cms-api/shipping-rates-*.ts` +
`src/lib/print-shipping.ts`) stays in the `/v1/shipping-rates` contract until
the cms-ceramics client stops listing it. Editing it has no storefront effect.

Published state = `shipping_rates.published_revision` pointing at a row in
`shipping_rate_drafts (rate_id, revision, payload)`. The code constants
(`SHIPPING_*` in `src/lib/pricing.ts`) are only the outage /
`CATALOG_SOURCE=code` fallback.

## Who reads them

Everything below reads the **published** table through
`getShippingRatesForDisplay()` (`src/lib/shipping-rates/get.ts`) — the same table
checkout charges from, with the same fallback ladder (last-known-good, then the
code constants):

- cart, ceramic PDP delivery block
- ceramic JSON-LD `shippingDetails`
- the `/dostawa-i-zwroty` copy (`{locker}` / `{courier}`, `src/lib/shipping-copy.ts`)

`src/lib/shipping-rates/display-parity.test.ts` fails CI if a surface goes back
to the constants. No copy in `messages/*.json` needs editing when rates change.

## After you publish new rates

1. **Check parity** (a few minutes after publishing; pages are `force-dynamic`).
   The published table (SQL, e.g. in the Supabase SQL editor):
   ```sql
   select r.id, r.published_revision, d.payload
   from shipping_rates r
   join shipping_rate_drafts d on d.rate_id = r.id and d.revision = r.published_revision;
   ```
   Then compare the cart and `/dostawa-i-zwroty` against it.
2. There is **no Merchant Center step** any more: the merchant feeds
   (`/api/feed/*`) answer `410` since 2026-11-21 and the `gmc:fetch` script was
   removed.

## Notes

- **Studio pickup (`odbior`)** is editable in the `domestic` resource. The cart and
  the ceramic PDP delivery block show the published price (free when 0), but the
  prose on `/dostawa-i-zwroty` and the contact page says pickup is free
  (`shipping.s1Li2`, `shipping.s4P`, `contact.*` in `messages/*.json`). Free pickup is
  the studio's stated policy; if you ever publish a non-zero `odbior`, update that
  copy in all four locales in the same change.
- A publish only changes `shipping_rates`; it does not touch prices.
