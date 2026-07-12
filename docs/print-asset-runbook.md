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

**Known limitation (Stage 4a):** readiness is checked in application code, then status is updated in a separate statement — a concurrent revoke or assignment change between the two could theoretically allow activation with stale coverage. Frequency is low; a DB-side RPC guard is deferred unless this surfaces in production.

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

**Access / WAF:** Prodigi fetches unsigned HTTP with HMAC query params only. Production gates only `/admin` and `/api/admin` (`worker.ts` → `isAdminPath`). If staging is placed behind Cloudflare Access, add a path **Bypass** policy for `/api/print-assets/*` and `/api/webhooks/prodigi/*` before enabling print fulfilment there.

## Signed-route smoke (deployed)

After at least one asset is `ready` or `retired`:

```bash
npm run print-asset:smoke -- --origin https://anna-ciok.studio [--asset-id <uuid>] [--json]
```

HEADs a freshly minted signed URL; output never includes `sig`. Exits non-zero on failure. Use after publish and before sandbox orders.

## Cutover evidence (Phase 6)

### Pre-cutover job check (production Supabase)

Run: `npm run print-fulfilment:check-jobs -- --json`

```json
{
  "checkedAt": "2026-07-12T09:04:20.470Z",
  "terminalStatuses": ["completed", "shipped", "cancelled", "failed_action_required"],
  "inflight": []
}
```

**Result:** zero in-flight print fulfilment jobs — safe to depend on `assetId` snapshots.

### Legacy R2 inventory (`{productId}/master.jpg`)

Run: `npm run print-assets:inventory` (requires `wrangler login` / valid Cloudflare API token).

**Retention plan (Rollout §6):** keep legacy objects for one release window after cutover; no code path selects them (`process-job.ts` signs snapshotted `assetId` only — no `printAssetKey()` / WebP fallback). `printAssetKey()` remains for inventory CLI only.

| Design | Legacy key | Status (operator) |
| --- | --- | --- |
| fap01 | `fap01/master.jpg` | _pending Wrangler auth_ |
| fap02 | `fap02/master.jpg` | _pending Wrangler auth_ |
| fap03 | `fap03/master.jpg` | _pending Wrangler auth_ |

### `fap01` distinct print-area profiles (sandbox matrix)

Seven profiles in `config/print-assets/fap01.json`. Place **one sandbox order per profile** (representative variant — not every frame colour when binaries share a profile):

| Profile | Representative variant | Prodigi SKU | Sandbox order | `prodigi_order_id` | Asset status |
| --- | --- | --- | --- | --- | --- |
| `3600x4800` | `30x40:false:false:none` | `GLOBAL-FAP-12X16` | _pending publish_ | | |
| `3614x4795` | `30x40:true:false:black` | `GLOBAL-CFP-12X16` | _pending publish_ | | |
| `2400x3600` | `30x40:true:true:black` | `GLOBAL-CFPM-12X16` | _pending publish_ | | |
| `6000x8400` | `50x70:false:false:none` | `GLOBAL-FAP-20X28` | _pending publish_ | | |
| `4800x7200` | `50x70:true:true:black` | `GLOBAL-CFPM-20X28` | _pending publish_ | | |
| `8400x12000` | `70x100:false:false:none` | `GLOBAL-FAP-28X40` | _pending publish_ | | |
| `7200x10800` | `70x100:true:true:black` | `GLOBAL-CFPM-28X40` | _pending publish_ | | |

Destructive E2E (one profile smoke — not full matrix):

```bash
PLAYWRIGHT_BASE_URL=<preview> E2E_DESTRUCTIVE=1 E2E_PRODIGI_SANDBOX=1 \
  npx playwright test e2e/print-purchase.spec.ts --grep @destructive
```

Per-profile orders: storefront checkout or `npm run prodigi -- order create` (sandbox only). Verify: `npm run prodigi -- order get <id>`, `/admin/fulfillment/[id]`, HEAD ETag/size vs manifest (`npm run print-asset:smoke`).

### Live rollout approval

**Status:** _not approved_ — blocked until `fap01` pipeline + full sandbox matrix complete. Do not set `PRODIGI_ENV=live` until operator signs off in PR.
