# Print Asset Operator Runbook

> Scope: fine-art prints fulfilment (`print_fulfilment_assets` → R2 → Prodigi)  
> Commands: `npm run print-assets:*` · Admin: `/admin/products/[id]` · Emergency revoke: `POST /api/admin/revoke-print-asset`

## Architecture (shipped)

1. **Prepare** exact-size derivatives per distinct print-area profile (`config/print-assets/{productId}.json`).
2. **Upload** immutable content-addressed keys to R2 (`anna-ciok-print-assets`).
3. **Verify** byte-identity against the local manifest; promote DB rows to `ready`.
4. **Publish** atomically assign the revision to every active variant (`publish_print_asset_revision` RPC).
5. **Checkout** snapshots `assetId` + hash into `order_items.variant` (immutable per paid order).
6. **Queue** mints a fresh **HMAC-signed** URL (`/api/print-assets/{assetId}?exp=&sig=`) at fulfilment time — **not** R2 presigned GETs.
7. **Prodigi** downloads from the Worker proxy; `ready` and `retired` assets are servable; `revoked` returns **410**.

See `docs/plans/print-asset-pipeline.md` for the full design.

## New artwork (first publication)

```bash
# 1. Author crop config (one focal/crop per distinct aspect ratio)
#    config/print-assets/fap01.json

# 2. Prepare derivatives + manifest (review proof-*.jpg locally)
npm run print-assets:prepare -- --product fap01 --revision 2026-07-12-r1 --source design/prints/fap01-master.tif

# 3. Upload to R2 + stage DB rows
npm run print-assets:upload -- --product fap01 --revision 2026-07-12-r1

# 4. Verify remote bytes match manifest; promote to ready
npm run print-assets:verify -- --product fap01 --revision 2026-07-12-r1

# 5. Atomic assignment to all active variants (requires explicit confirm)
npm run print-assets:publish -- --product fap01 --revision 2026-07-12-r1 --confirm 2026-07-12-r1

# 6. Confirm readiness in admin (/admin/products/fap01) — all variants green
# 7. Activate product status (blocked until readiness is complete)
```

**Gate:** `getPrintAssetReadiness(fap01).ready === true` before `draft/hidden → active`.

## Revision replacement (corrected artwork)

1. Run **prepare → upload → verify → publish** with a **new revision** string.
2. The publish RPC swaps every assignment in one transaction; prior R2 objects remain for historical orders.
3. New checkouts resolve the new assignment; paid orders keep their snapshotted `assetId`.

**Rollback to prior assignment:** re-run `print-assets:publish` with the last known-good revision's manifest assignments (objects must still be `ready`). Never mutate or overwrite R2 keys.

## Retirement vs revocation

| Action | Status transition | New checkout | Historical fulfilment |
| --- | --- | --- | --- |
| **Retire** | `ready → retired` | Blocked | Signed route still serves (200) |
| **Revoke** | `* → revoked` (emergency) | Blocked | Signed route returns **410** |

- **Retire** is the normal lifecycle when superseding a revision (old asset no longer sold, but existing orders still print).
- **Revoke** is an emergency stop (bad file, legal hold). Use admin **Unieważnij** or `POST /api/admin/revoke-print-asset` with `{ "assetId": "…", "force": true }` when the asset is still assigned to an active variant.

## Emergency revocation

```bash
# Prefer admin UI on /admin/products/{id} — shows per-variant coverage + revoke buttons.

# API (Cloudflare Access–gated in production):
curl -X POST https://anna-ciok.studio/api/admin/revoke-print-asset \
  -H 'Content-Type: application/json' \
  -d '{"assetId":"<uuid>","force":true}'
```

After revoke: product cannot activate / sell affected variants until a new revision is published. In-flight queue jobs for snapshotted orders will fail action-required (asset gone).

## DLQ recovery (`prodigi-fulfilment-dlq`)

1. Inspect failed messages in the Cloudflare dashboard (Queues → `prodigi-fulfilment-dlq`).
2. Fix root cause (missing asset, bad snapshot, Prodigi outage).
3. For **transient** failures: re-drive from DLQ after fix, or use admin fulfilment retry if exposed.
4. For **missing/revoked asset** on a paid order: do **not** re-queue until a valid `assetId` is servable or the order is refunded manually.

Use `npm run orders -- order get <uuid>` and `/admin/fulfillment/[id]` for job state.

## Safe R2 cleanup

- **Never delete** R2 objects referenced by `ready`, `retired`, or any paid `order_items.variant.assetId`.
- Deletion is a separate operational policy after the support/reprint window closes.
- Keys are content-addressed (`prints/{productId}/{revision}/{w}x{h}-{sha256}.{ext}`) — deleting a key does not update DB rows; orphaned rows surface as `not_found` at fulfilment time.

Inventory check: `npm run print-assets:inventory`

## Sandbox proof before live rollout

1. Set `PRODIGI_ENV=sandbox` and sandbox API key.
2. Place **one sandbox order per distinct print-area profile** (not every frame colour when the binary is shared).
3. Verify Prodigi asset status reaches `complete`: `npm run prodigi -- order get <prodigi_order_id>`
4. Confirm callback progression on `/admin/fulfillment/[id]`.
5. Operator sign-off before `PRODIGI_ENV=live`.

## Environment notes

| Variable | Role |
| --- | --- |
| `PRINT_ASSET_TOKEN_SECRET` | HMAC for `/api/print-assets/[id]` |
| `WORKER_ORIGIN` | Public origin for signed URLs + Prodigi callbacks (staging); production defaults to `https://anna-ciok.studio` |
| `PRINT_ASSETS_BUCKET` | Optional override for CLI upload target (`.dev.vars`) |

**Access / WAF:** Prodigi fetches unsigned HTTP with HMAC query params only. If staging is placed behind Cloudflare Access, add a path bypass for `/api/print-assets/*` and `/api/webhooks/prodigi/*`.
