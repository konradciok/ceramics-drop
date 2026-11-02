# Shipping rates runbook

How a change to shipping rates reaches the storefront, the Merchant Center feed
and Google, and what to do after publishing one.

## Where the rates live

Two CMS resources (served by the `CmsApi` entrypoint, `/v1/shipping-rates`):

| Resource id | Track | Shape |
|---|---|---|
| `domestic` | ceramics (InPost) | per currency (PLN / EUR / GBP) × `paczkomat` / `kurier` / `odbior` |
| `international` | prints (Prodigi) | per `PRINT_COUNTRIES` entry × `framed` / `loose`, in EUR; PLN/GBP are derived with the print pricing config's FX rates |

Published state = `shipping_rates.published_revision` pointing at a row in
`shipping_rate_drafts (rate_id, revision, payload)`. The code constants
(`SHIPPING_*` in `src/lib/pricing.ts` / `src/lib/print-shipping.ts`) are only the
outage / `CATALOG_SOURCE=code` fallback.

## Who reads them

Everything below reads the **published** table through
`getShippingRatesForDisplay()` (`src/lib/shipping-rates/get.ts`) — the same table
checkout charges from, with the same fallback ladder (last-known-good, then the
code constants):

- cart (ceramics + prints), ceramic PDP delivery block
- JSON-LD `shippingDetails` (ceramic + print PDP, collection pages)
- Merchant Center feed `g:shipping` (`/api/feed/google`, `/api/feed/meta`)
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
   What Google will read, and what the page says (shell):
   ```bash
   curl -s "https://anna-ciok.studio/api/feed/google?market=pl" | grep -m3 "<g:price>\|<g:shipping>"
   curl -sL "https://anna-ciok.studio/fine-art-prints/fap001" | grep -o '"shippingRate":{[^}]*}' | head -4
   ```
   The feed's `g:shipping` price and the JSON-LD loose rate for the same country
   must equal the published `international` rate for that country (rounded up,
   in the market currency).
2. **Refresh Merchant Center** — it only fetches the feeds once a day, so without
   this a stale shipping price stays in Google for up to 24 h:
   ```bash
   npm run gmc:fetch                 # dry run: lists the sources
   npm run gmc:fetch -- --confirm    # triggers the fetch of every scheduled-fetch source
   ```
   Needs a service account key with access to the account
   (`--key-file`, `GMC_KEY_FILE` or `GOOGLE_APPLICATION_CREDENTIALS`).
3. **Confirm** in Merchant Center (Products → Diagnostics) or through the
   Merchant API that no new `price`/`shipping` mismatch issues appeared.

## Notes

- The feed advertises the **loose** (unframed) rate next to the "from" price; the
  JSON-LD lists both loose and framed per country. That is intentional.
- The Merchant Center account still carries a legacy account-level flat shipping
  service (`dostawa_flat`, 8 € to 21 countries). Item-level shipping from the feed
  takes precedence, but it should be removed once every product is confirmed to
  carry its own shipping (decision pending, see `docs/STATUS.md`).
- A publish only changes `shipping_rates`; it does not touch prices. For price
  changes the same `gmc:fetch` step applies (`docs/STATUS.md` → Print pricing).
