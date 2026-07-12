# Print Asset Pipeline — Current-State Remediation Plan

> Date: 2026-07-10  
> Status: Phase 6 in progress (cutover & production proof)  
> Scope: print-ready artwork only (`fine-art-prints` → R2 → Prodigi)

## Outcome

Build a reproducible, fail-closed pipeline that turns an approved local artwork master into exact Prodigi print-area derivatives, uploads immutable objects to R2, assigns them to sellable print variants, snapshots the selected asset on the order, and serves it to Prodigi through the existing signed Worker endpoint.

The pipeline is complete only when a newly published print cannot be purchased without a verified print-ready asset for every active variant, and a paid order can never silently fall back to a storefront WebP.

## Current Repository State

### Already implemented and should be retained

- `wrangler.jsonc` already binds `PRINT_ASSETS` to `anna-ciok-print-assets` and configures the `prodigi-fulfilment` queue.
- `src/lib/print-assets.ts` signs seven-day HMAC URLs at queue-processing time.
- `src/app/api/print-assets/[id]/route.ts` validates the signature and streams an R2 object.
- `src/server/fulfilment/process-job.ts` builds the asset URL immediately before `POST /orders` to Prodigi.
- `src/lib/print-cart.ts` contains the verified Prodigi SKU and recommended print-area pixel dimensions.
- Storefront WebPs in `public/uploads/` are already separate from the intended fulfilment masters.
- The product catalogue now reads from Supabase in production (`CATALOG_SOURCE=db`), with print variants represented by `product_variants`.

### Stale or unsafe assumptions

1. The repository does **not** use direct R2 presigned GETs. A bound `R2Bucket` exposes `get/head/put`, not `createSignedUrl`; the implemented architecture is an HMAC-authenticated Worker proxy. Keep that architecture unless S3 credentials are deliberately introduced.
2. Some Prodigi documentation in the repository still describes a direct presign and “no Worker proxy”, which conflicts with the shipped code.
3. There is no script, manifest, admin action, or documented command that prepares, uploads, inventories, or verifies the expected `{productId}/master.jpg` objects.
4. One mutable `{productId}/master.jpg` is reused for every variant. The current variants have materially different print areas and aspect ratios (mounted variants are often 2:3), while `fillPrintArea` tells Prodigi to crop centrally. A single unreviewed master therefore cannot guarantee composition.
5. When R2 or `PRINT_ASSET_TOKEN_SECRET` is absent, `process-job.ts` submits the low-resolution public storefront image. That is acceptable as a UI fixture but unsafe as a fulfilment fallback.
6. The chosen asset is not snapshotted into `order_items.variant`. Replacing `fap01/master.jpg` after checkout can change what a paid historical order prints.
7. Publishing and checkout do not verify that every active variant has a ready asset.
8. There are no focused tests for HMAC signing/expiry, the R2 route, exact asset selection, missing assets, or production fail-closed behavior. The current `process-job` test exercises the public-image fallback.
9. `SITE_URL` is hardcoded to production, so the signed asset and Prodigi callback URLs cannot point at a future staging Worker. This must be resolved before the staging plan can exercise print fulfilment independently.
10. `docs/cloudflare-deployment.md` still says Queues and R2 are not provisioned.
11. `pod_variants` is unique by SKU and `sync-prodigi-skus.ts` stores only `variants[0]` from the Prodigi product response. A SKU can expose different print-area pixels for different attributes (the current `GLOBAL-CFP-12X16` mapping proves this), so this table cannot currently be the variant-level dimension source of truth.

## Settled Architecture

### 1. Exact derivatives, not implicit Prodigi crops

Generate one approved JPG or PNG derivative for each **distinct required print-area dimension** used by a design's active variants. Variants with identical dimensions may share a derivative; variants with different dimensions must have separate derivatives.

- Dimensions come from the verified `PRODIGI_SKU_MAP` and are persisted per `product_variants.variant_key`, not inferred from nominal centimetre labels or a SKU-only row.
- Never enlarge a source. Fail preparation when the source cannot cover the target pixels.
- Require an explicit crop/focal configuration for every distinct aspect ratio. Do not silently accept Sharp's or Prodigi's centre crop.
- Keep `sizing: 'fillPrintArea'` as defense in depth after the submitted derivative already matches the exact target dimensions.
- Use JPG/PNG only for generated derivatives. Prodigi can resize those formats; PDFs are processed at the received size and are not useful for this derivative workflow.

### 2. Immutable, content-addressed R2 keys

Replace mutable keys such as `fap01/master.jpg` with:

```text
prints/{productId}/{revision}/{width}x{height}-{full-sha256}.{jpg|png}
```

Never overwrite a key. A corrected artwork creates a new revision and new assignments. Retain old objects while an order or support/reprint window may still reference them; lifecycle deletion is a separate operational policy.

Once an asset is `ready`, make its `r2_key`, hash, content type, byte size, and dimensions immutable at the database layer. Only status transitions are allowed.

### 3. Database-backed readiness and assignment

Add dedicated tables rather than putting fulfilment metadata in `product_media` (which is public display media) or directly on `product_variants` (which the current backfill replaces):

```text
print_fulfilment_assets
  id uuid primary key
  product_id text references products(id)
  revision text
  profile_key text                 -- e.g. 3600x4800
  r2_key text unique
  sha256 text
  content_type text                -- image/jpeg | image/png
  width_px integer
  height_px integer
  byte_size bigint
  status text                      -- staged | ready | retired | revoked
  created_at / verified_at timestamptz

print_variant_asset_assignments
  product_id text references products(id)
  variant_key text
  asset_id uuid references print_fulfilment_assets(id)
  primary key (product_id, variant_key)
```

Also add nullable `print_area_width_px` / `print_area_height_px` columns to `product_variants`. Populate them for prints from `PRODIGI_SKU_MAP[variant_key]`; ceramics remain null. These columns are the database-side contract the atomic publish RPC checks.

Do not FK assignments to the replaceable `product_variants.id`. Validate the natural `(product_id, variant_key)` against active catalogue variants in the publish/readiness transaction.

Add an atomic `publish_print_asset_revision(product_id, revision, assignments_json)` RPC that:

1. locks the print product;
2. verifies every active variant is mapped exactly once;
3. verifies each asset belongs to that product, is `ready`, and its dimensions equal the variant's `printAreaPx`;
4. swaps all assignments in one transaction;
5. writes an audit record.

### 4. Snapshot the fulfilment asset at checkout

Extend the existing `CheckoutVariant` / `order_items.variant` JSON with:

```ts
assetId: string;
assetKey: string;
assetSha256: string;
assetContentType: 'image/jpeg' | 'image/png';
assetWidthPx: number;
assetHeightPx: number;
```

No new `order_items` column is required. The JSON snapshot makes a paid order immutable even when the design's active revision later changes.

`validateCart()` must resolve the current assignment server-side and return `print_asset_unavailable` when it is missing, revoked, or dimensionally inconsistent. The checkout route maps that to `409 { error: 'print_asset_unavailable' }` with localized cart guidance. Never trust an asset identifier supplied by the browser token.

### 5. Keep the signed Worker proxy, but sign an asset identity

Change `signPrintAssetUrl(productId, ...)` to sign the snapshotted `assetId` (plus expiry). The route resolves the asset record to its immutable `r2_key`, permits `ready` and `retired` assets, rejects `revoked`, and streams the R2 object.

- Supply the public origin explicitly from an environment-aware server helper; do not bake `SITE_URL` into the signer.
- Continue minting the URL in the queue consumer, not at checkout.
- Keep the seven-day TTL initially. Every retry mints a fresh URL; confirm the sandbox asset reaches Prodigi's `complete` status well inside that window before live cutover.
- Return the R2 `Content-Type`, `Content-Length`, and quoted `ETag`; support `HEAD` using `R2Bucket.head()` for verification. Range support is optional unless a Prodigi sandbox trace proves it is required.
- Never log the signed URL or query signature.

### 6. Fail closed

Delete the public storefront-image fallback from the fulfilment path. Missing bindings, secret, assignment, database row, or R2 object must mark the fulfilment job retryable/action-required according to cause and must never call Prodigi with display artwork.

Local development can use an explicitly seeded local R2 bucket through `npm run preview:cf`; unit tests should inject a fake asset resolver. Do not add an implicit production behavior for local convenience.

## Implementation Plan

### Phase 0 — Safety baseline and characterization

- [x] Add `src/lib/print-assets.test.ts` covering deterministic signing, tampering, malformed signatures, expiry boundary, and future expiry.
- [x] Add `src/app/api/print-assets/[id]/route.test.ts` covering missing configuration, invalid signature, unknown/revoked asset, missing R2 object, `GET`, and `HEAD` metadata (HEAD/revoked deferred to Phase 4 — see file header).
- [x] Expand `src/server/fulfilment/process-job.test.ts` to prove the R2/signed-URL branch and capture the current fallback as a test that will be inverted in Phase 3.
- [x] Add a read-only inventory command that reports which current published designs have the legacy `{productId}/master.jpg` object (`npm run print-assets:inventory`; enumerates via `getPrintDesigns()`, not the code registry alone).
- [x] Confirm all current live print orders/jobs are either absent or complete before changing key semantics (`npm run print-fulfilment:check-jobs` — run against prod and paste JSON in the PR before merge). _(Phase 6 — 2026-07-12: zero in-flight; see runbook cutover evidence)_

Gate: current behavior is characterized, remote asset inventory is recorded, and no in-flight job depends on an expiring implementation change.

### Phase 1 — Asset metadata and atomic assignment

- [x] Add `supabase/migrations/<timestamp>_print_fulfilment_assets.sql` with both tables, per-variant print-area columns, constraints, indexes, RLS, and the atomic publish RPC.
- [x] Extend `VariantSeedRow`, `buildCatalogSeed()`, mappers, and parity tests so every print `product_variants` row carries the exact `PRODIGI_SKU_MAP[variant_key].printAreaPx`; ceramics carry nulls.
- [x] Correct `sync-prodigi-skus.ts` to validate each offered attribute combination and compare its returned dimensions to the per-variant catalogue contract. Keep `pod_variants` as a SKU lookup/cache, not the sole dimension authority.
- [x] Add row types and server repository helpers under `src/server/print-assets/`.
- [x] Implement `getPrintAssetReadiness(productId)` and `resolvePrintAsset(productId, variantKey)` against the DB-backed catalogue.
- [x] Ensure `catalog:backfill` neither deletes nor rewrites asset records/assignments.
- [x] Add migration/RPC tests for incomplete mapping, wrong-product asset, dimension mismatch, immutable ready metadata, atomic swap, retirement, and repeat publication.

Gate: a revision can be staged and atomically assigned to every active variant, while the old assignment remains live on any failure.

### Phase 2 — Deterministic prepare, review, upload, and verify tooling

Add tracked configuration under `config/print-assets/{productId}.json`; keep source masters and generated binaries under the already-ignored `design/` tree.

Add scripts and package commands:

```text
npm run print-assets:prepare -- --product fap01 --revision 2026-07-10-r1 --source <path>
npm run print-assets:upload  -- --product fap01 --revision 2026-07-10-r1
npm run print-assets:verify  -- --product fap01 --revision 2026-07-10-r1
npm run print-assets:publish -- --product fap01 --revision 2026-07-10-r1 --confirm 2026-07-10-r1
```

- [x] `prepare`: enumerate active variants, deduplicate exact dimensions, validate source metadata, apply explicit crops, output exact-size JPG/PNG files, preserve/embed the approved colour profile, and emit a manifest containing hashes and assignments.
- [x] `prepare`: fail on enlargement, unexpected alpha handling, unsupported format, duplicate/missing profile, dimension mismatch, or non-deterministic output.
- [x] `prepare`: create small review proofs/contact sheets next to the local output; proofs never become fulfilment assets.
- [x] `upload`: call the current Wrangler CLI form `wrangler r2 object put {bucket}/{key} --file ... --content-type ... --remote`; check before writing, reuse an existing object only after its full streamed hash matches, and abort on any mismatch.
- [x] `upload`: stage the corresponding database rows only after every upload succeeds.
- [x] `verify`: streamed authenticated `GET` compares size, decoded dimensions, and the full SHA-256 against the local manifest without loading the whole object into memory. (Content-type round-trip verification needs R2 `head`, which Wrangler 4.x lacks — deferred to the Phase 4 Worker `head` route; the content-addressed full-hash match already proves byte-identity of the object uploaded with an explicit `--content-type`.)
- [x] `publish`: require explicit operator confirmation (`--confirm <revision>`), then call the atomic assignment RPC.
- [x] Add unit tests using tiny fixtures for crop math, profile deduplication, determinism, manifest validation, and refusal to overwrite. (Phase 2b adds staged-row projection, upload reuse/abort decision, idempotent staging partition, remote-vs-manifest comparison, and publish-assignment resolution.)

Gate: `fap01` can be prepared twice byte-for-byte, visually approved, uploaded, verified, and published without editing application code.

### Phase 3 — Checkout snapshot and fail-closed fulfilment

- [x] Extend `CheckoutVariant` in `src/lib/checkout.ts` with the resolved asset snapshot.
- [x] Resolve assignments from the server repository during print validation; add `print_asset_unavailable` to the result/error contract and localized cart copy.
- [x] Persist the snapshot unchanged in `order_items.variant` from `src/app/api/checkout/route.ts`.
- [x] Update `PrintItemRow` in `src/server/prodigi/mapper.ts` and validate that snapshot dimensions match `printAreaPx` before payload construction.
- [x] Refactor `process-job.ts` to sign `item.variant.assetId`; delete the public WebP fallback.
- [x] Classify a missing DB row/object as `failed_action_required`; classify transient DB/R2 lookup failures as retryable. A bad asset must never reach `postOrder()`.
- [x] Include the asset revision/hash prefix in safe structured logs and admin fulfilment detail, but never include the signed URL.
- [x] Bump the Prodigi idempotency-key payload version only if the request contract changes for already-retryable jobs; document the transition so an old paid order cannot create a duplicate.

Gate: a paid order continues to reference the exact same immutable asset after a newer design revision is published, and all missing-asset paths stop before the Prodigi API call.

### Phase 4 — Signed route and environment hardening

- [x] Update `src/lib/print-assets.ts` to sign/verify `assetId:exp` and accept an explicit public origin.
- [x] Update `/api/print-assets/[id]` to resolve the immutable key, implement `HEAD`, return metadata/ETag, and distinguish 403, 404, 410, and 503 without leaking bucket keys.
- [x] Extend the minimal `R2Bucket` shapes in `cloudflare-bindings.d.ts` for `head`, `httpEtag`, and required metadata, then run `npm run cf-typegen`.
- [x] Make the fulfilment/callback origin environment-aware as required by `docs/plans/staging-plan.md`; production remains `https://anna-ciok.studio`.
- [x] Verify that Cloudflare Access/WAF rules do not block Prodigi's unsigned network request to the **HMAC-protected** print asset route. Before staging goes behind Access (`docs/plans/staging-plan.md`), add a Zero Trust **Access Bypass policy** (path-based) for `/api/print-assets/*` and confirm `/api/webhooks/prodigi/*` is likewise reachable — Prodigi cannot present a JWT, only the HMAC query params. Production is unaffected today (`worker.ts` only gates `/admin` via `isAdminPath`). _(Phase 6 — production confirmed; staging bypass documented in runbook)_
- [x] Add a deployed smoke test that fetches a signed URL without exposing the signature in CI logs (`npm run print-asset:smoke` + `src/lib/print-asset-smoke.ts`; requires a `ready`/`retired` asset row).

Gate: production and staging generate URLs to their own Workers/buckets and Prodigi sandbox reports the submitted asset status as downloaded/complete.

### Phase 5 — Publish guard, admin visibility, docs, and cutover

- [x] Block `draft/hidden → active` for print products in `updateProductStatus()` unless readiness covers every active variant.
- [x] Show asset readiness, revision, dimensions, verified timestamp, and missing variants in the existing admin product editor. Upload UI remains out of scope for v1; scripts are the write path.
- [x] Add a “revoke” action that is separate from “retire”; retirement preserves historical fulfilment, revocation is an emergency stop.
- [x] Update `prodigi/decisions.md`, `prodigi/masterprompt.md`, `prodigi/phases.md`, `docs/cloudflare-deployment.md`, `.env.example`, and `AGENTS.md` to describe the shipped proxy and commands accurately.
- [x] Add an operator runbook for new artwork, revision replacement, rollback to a prior assignment, emergency revocation, DLQ recovery, and safe R2 cleanup.
- [x] Run the full regression gate: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run preview:cf`, and the print checkout E2E. _(Phase 6 PR — automated; see PR test plan)_
- [ ] Place one Prodigi sandbox order for each distinct print-area profile (not all frame colours when the binary is shared), verify download/crop/status callbacks, then approve live rollout. _(Phase 6 operator gate — blocked until `fap01` assets published; matrix in runbook)_

Gate: an operator can add or revise a print using documented commands, the admin prevents incomplete publication, and sandbox proves the entire paid-order-to-download path.

### Phase 6 — Cutover & production proof

Operator execution + thin automation closure. Does not reopen settled architecture (HMAC Worker proxy, `assetId` snapshots, fail-closed fulfilment).

- [x] Pre-cutover: `npm run print-fulfilment:check-jobs -- --json` against production — zero in-flight jobs (2026-07-12).
- [ ] Pre-cutover: `npm run print-assets:inventory` against production R2 (requires valid Wrangler auth) — record legacy `{productId}/master.jpg` retention; `process-job.ts` has no WebP/legacy fallback (verified in code review).
- [ ] Production asset pipeline per published design (`fap01` first): prepare → visual sign-off → upload → verify → publish with studio-approved artwork (not placeholder crops in `config/print-assets/fap01.json`).
- [ ] Admin readiness: `/admin/products/fap01` all variants green before `draft/hidden → active`.
- [x] Access/WAF: production only gates `/admin`; document staging bypass for `/api/print-assets/*` and `/api/webhooks/prodigi/*` (runbook).
- [x] Signed-route smoke helper: `npm run print-asset:smoke` (HEAD, redacted `sig` in output).
- [ ] Sandbox: one order per distinct print-area profile on preview with `PRODIGI_ENV=sandbox` — record matrix in runbook + PR.
- [ ] Live rollout approval: do **not** set `PRODIGI_ENV=live` until sandbox matrix is signed off.

Gate: operator can publish artwork via scripts; admin blocks incomplete activation; sandbox proves paid-order → Prodigi download; production cutover explicitly approved in PR.

## Test Matrix

| Layer | Required proof |
|---|---|
| Preparation | exact dimensions, no enlargement, deterministic hashes, explicit crop coverage |
| R2 | immutable key, correct metadata, `head/get`, missing object, overwrite refusal |
| Database | full active-variant coverage, atomic publish, historical revision retained |
| Checkout | browser cannot choose asset, missing/revoked assignment blocks payment, JSON snapshot persisted |
| Queue | transient retry, permanent missing asset action-required, no public-image fallback, duplicate delivery idempotent |
| Signed route | expiry/tamper rejection, `GET`/`HEAD`, revoked/missing behavior, no key leakage |
| Prodigi | exact URL in payload, `fillPrintArea`, asset download complete, callback progression |
| Environment | staging URL/bucket/token isolation and production URL/bucket/token isolation |

## Rollout and Rollback

1. Ship schema and read-only tooling first.
2. Prepare/upload/verify all currently published designs while legacy lookup still works.
3. Publish database assignments and prove readiness reports green.
4. Deploy checkout snapshot + queue resolution + signed-route changes together.
5. Run a sandbox order and inspect Prodigi asset status before enabling live print checkout.
6. Keep legacy `{productId}/master.jpg` objects for one release window, but remove all code paths that select them.

Rollback the application to the prior release only while legacy objects still exist. After the snapshot format is live, forward compatibility is required: the old route must not be redeployed if it cannot serve `assetId` snapshots. Database assignment rollback is an atomic republish of the last known-good revision; never overwrite or mutate the bad R2 object.

**Queue safety during rollback:** pause or drain the `prodigi-fulfilment` queue before rolling back application code. A rolled-back `process-job.ts` must not consume jobs whose `order_items.variant` already carries an `assetId` snapshot — those orders require the Phase 3+ consumer. Either (a) leave snapshot orders on the new release until their jobs complete, or (b) re-queue them only after verifying the target release understands `assetId`. Never roll back into a build that would silently substitute legacy `{productId}/master.jpg` or the public WebP for a snapshotted order.

## Explicit Non-Goals

- Public delivery of R2 masters or an `r2.dev` bucket.
- Uploading print masters through an unauthenticated storefront route.
- Reusing `product_media` as fulfilment storage metadata.
- Automated generative upscaling or sharpening.
- Automatic artwork approval; visual crop and colour review remain a studio decision.
- Deleting historical R2 assets as part of publication.

## Source Contracts

- Prodigi order assets and resizing: <https://www.prodigi.com/print-api/docs/reference/> — assets must be publicly fetchable; `fillPrintArea` crops to the print area; product lookup exposes recommended pixel dimensions.
- Cloudflare R2 uploads: <https://developers.cloudflare.com/r2/objects/upload-objects/> and <https://developers.cloudflare.com/workers/wrangler/commands/r2/>.
- Cloudflare R2 Worker API: <https://developers.cloudflare.com/r2/api/workers/workers-api-reference/> — bound buckets support `head/get/put`; object metadata includes `httpEtag`.
