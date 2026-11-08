# Fine-Art Prints & Prodigi

> Moved verbatim from `AGENTS.md` (context-diet restructure). `AGENTS.md` keeps a short stub with the invariants; this file holds the full detail. Perishable feature state lives in `docs/STATUS.md`.

### Fine-Art Prints & Prodigi (print-on-demand)

Prints are fulfilled by **Prodigi**, a POD partner — the store never holds print stock. The integration lives under `src/server/` (third-party fulfilment layer, kept out of `src/lib/`):

- **Catalogue & cart:** `src/lib/prints.ts` (designs), `src/lib/print-cart.ts` (`print:` token encoding + `PRODIGI_SKU_MAP` mapping variants → Prodigi SKUs), `src/lib/print-pricing.ts` + `src/lib/print-pricing-config/` (global admin-editable price list — see Pricing & Shipping) and `src/lib/print-shipping.ts` (shipping by EU/UK destination).
- **Curation:** `src/lib/print-collections.ts` + `print-curation.ts` group designs (by id) into named, ordered `PRINT_COLLECTIONS` for display on `/fine-art-prints`, with an `UNASSIGNED_COLLECTION` ("inne") fallback bucket for anything not listed. Membership is kept out of `PrintDesign` itself — under `CATALOG_SOURCE=db` the catalog mapper rebuilds designs field-by-field from DB rows, so a registry-only field would be silently dropped.
- **Delivery & address:** `src/components/shop/PrintDeliveryForm.tsx` — native print checkout address form (WHATWG autofill tokens `section-print shipping …`, session draft under `acc_print_delivery_v1`, key in `src/lib/print-delivery-key.ts`), validated client+server by `validatePrintDelivery` in `src/lib/print-delivery.ts` (phone → E.164). `src/lib/shipping-address.ts` (`normalizeShippingAddress`) reads both the legacy ceramic `{street, building_number}` JSONB shape and the native print `{line1, line2}` shape — used by the Prodigi mapper, invoices, admin pages, CSV export, and server-side conversions.
- **Print assets:** `src/lib/print-assets.ts` mints **HMAC-signed R2 URLs** for the high-res files Prodigi pulls; served via **`/api/print-assets/[id]`**.
- **Prodigi client:** `src/server/prodigi/` — `client.ts` (`postOrder`/`getOrder`/`getProduct`, sandbox vs live via `PRODIGI_ENV`), `mapper.ts` (`buildProdigiPayload()`), `callbacks.ts`, `types.ts`.
- **Prodigi CLI:** `npm run prodigi -- …` (`scripts/prodigi-cli.ts`) — prefer this for Prodigi API debugging and sandbox operations (SKU lookup, quotes, order inspection/mutations) instead of ad-hoc scripts; full usage in `docs/prodigi-cli.md`. Paid production orders still go through the queue — live `order create` is blocked in the CLI.
- **Queue pipeline:** the Stripe webhook enqueues via `src/server/fulfilment/enqueue.ts` → Cloudflare Queue `prodigi-fulfilment` → `src/server/fulfilment/process-job.ts` submits to Prodigi; `status-map.ts` normalises Prodigi statuses.
- **Callback webhook:** **`/api/webhooks/prodigi/[token]`** receives shipment/status updates, validated against `PRODIGI_CALLBACK_TOKEN`.
- **Sync:** `npm run sync-prodigi-skus` reconciles SKUs into the `pod_variants` table. SKU reference: `docs/prodigi-sku-catalog.md` (the verified size/frame/print-area matrix); the original build-time design docs are archived in `docs/archive/prodigi/`.
