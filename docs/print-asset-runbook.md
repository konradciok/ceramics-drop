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

Place the approved, artwork-only master and, when the product config includes a
`signature`, its SVG at the canonical gitignored paths:

```text
design/print-assets/{productId}/artwork-master.png
design/print-assets/{productId}/signature.svg
```

The artwork master must not contain a baked border or signature. Author one
product-level proportional `layout` in `config/print-assets/{productId}.json`;
the prepare script resolves it independently for every active Prodigi profile.
When configured, export the signature as a self-contained, path-only SVG:
convert lettering to outlines and remove embedded images, scripts, foreign
objects, external links, and external CSS resources. Font-backed `<text>` is
rejected because it renders differently when an operator machine does not have
the same font installed. Without a `signature` config, omit the SVG; prepare
collapses the signature gap and zone automatically.

```bash
# 1. Author proportional composition config
#    config/print-assets/fap01.json

# 2. Prepare derivatives + manifest (review proof-*.jpg locally)
npm run print-assets:prepare -- --product fap01 --revision 2026-07-17-r1 --dry-run
npm run print-assets:prepare -- --product fap01 --revision 2026-07-17-r1

# STOP: review every proof-*.jpg with the studio before any upload.
# Tune layout fractions and re-run with --force until approved.

# 3. Upload to R2 + stage DB rows
npm run print-assets:upload -- --product fap01 --revision 2026-07-17-r1

# 4. Verify remote bytes match manifest; promote to ready
npm run print-assets:verify -- --product fap01 --revision 2026-07-17-r1

# 5. Atomic assignment to all active variants (requires explicit confirm)
#    Optional --actor <email> records the operator in catalog_audit_log.
npm run print-assets:publish -- --product fap01 --revision 2026-07-17-r1 --confirm 2026-07-17-r1

# 5b. Generate storefront gallery WebPs from the published fulfilment master,
#     upload to R2 `prints/{productId}/gallery/{slot}/`, mirror to public/uploads/.
#     Re-run when a new revision publishes and the hero should update.
npm run print-assets:gallery -- --product fap01

# 6. Confirm readiness in admin (/admin/products/fap01) — all variants green
# 7. Activate product status (blocked until readiness is complete)
```

**Gate:** `getPrintAssetReadiness(fap01).ready === true` before `draft/hidden → active`.

### Tuning the proportional layout

- `sideMargin`: left/right inset as a fraction of the canvas short side.
- `topMargin` and `bottomMargin`: vertical edge spacing as fractions of canvas height.
- `gapAboveSignature`: space between the artwork region and signature zone.
- `signatureZoneHeight`: height available to contain-fit the SVG signature.
- `artworkMaxWidth` and `artworkMaxHeight`: optional ceilings that create additional breathing room without cropping.

Preparation fails before output when the config, SVG, source dimensions, or
resolved geometry is invalid. The generated `proof-*.jpg` files show the full
composition but are never included in the upload manifest. Output pixels are
colour-managed into an embedded sRGB profile so the artwork and configured RGB
background share a declared colour space.

Activation uses the `update_product_status_guarded` RPC. It locks the product,
active variants, assignments, and assigned asset rows, revalidates complete
ready/dimension-matched coverage, then updates status and writes the audit row
in the same transaction. Concurrent revision publication is serialized on the
product lock; a concurrent asset revoke completes either before the check or
after activation as a distinct emergency action.

## Revision replacement (corrected artwork)

1. Place the corrected artwork-only master and, when configured, signature SVG; then run **prepare** with a **new revision** string.
2. Review every proportional-composition proof and obtain studio approval.
3. Only after approval, run **upload → verify → publish** for that revision.
4. The publish RPC swaps every assignment in one transaction; prior R2 objects remain for historical orders.
5. New checkouts resolve the new assignment; paid orders keep their snapshotted `assetId`.

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

**Access / WAF (print fulfilment):** Prodigi fetches unsigned HTTP with HMAC query params only. Production gates only `/admin` and `/api/admin` (`worker.ts` → `isAdminPath`). **Two dashboard changes are required on `anna-ciok.studio` before Prodigi can download assets:**

1. **Bot Fight Mode → Off** (Security → Settings, Bot traffic filter). On the Free plan BFM **cannot** be skipped per-path via WAF custom rules — it runs outside the Ruleset Engine. JS Detections may still display "On" in the UI when BFM is off; that label is not separately toggleable ([Cloudflare docs](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)).
2. **WAF custom rule → Skip** (Security → Security rules → Custom rules):
   - Expression: `starts_with(http.request.uri.path, "/api/print-assets/")`
   - Action: **Skip** → tick **All managed rules**, **Browser Integrity Check** (and **All Super Bot Fight Mode rules** if on Pro).
3. **Configuration rule** (optional belt-and-braces): Rules → Configuration rules → Browser Integrity Check **Off** for the same path expression.

If staging is placed behind Cloudflare Access, add a path **Bypass** policy for `/api/print-assets/*` and `/api/webhooks/prodigi/*` before enabling print fulfilment there.

**Verified 2026-07-13:** With BFM off + WAF skip live, run `2026-07-13-1017` (`ord_1162949`–`ord_1162955`) — all 7 profiles `downloadAssets: Complete`; firewall events show `skip/firewallCustom` from Prodigi IPs, zero `botFight` challenges; Worker logs show GET 200 on `/api/print-assets/*`.

## Signed-route smoke (deployed)

After at least one asset is `ready` or `retired`:

```bash
npm run print-asset:smoke -- --origin https://anna-ciok.studio [--asset-id <uuid>] [--json] [--allow-missing]
# or, to target the origin from .dev.vars / an --env-file's WORKER_ORIGIN instead of --origin:
npm run print-asset:smoke -- --env-file .dev.vars
```

HEADs a freshly minted signed URL; output never includes `sig`. Exits non-zero on failure. Use after publish and before sandbox orders. When `--asset-id` is omitted the probe prefers a `ready` row (proof something sellable is live) and only falls back to `retired` if none exists.

Requires `PRINT_ASSET_TOKEN_SECRET` **and** `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — `resolveAssetId()` always looks up the asset row in Supabase (to fetch `product_id`/`profile_key`/`status`), even when `--asset-id` is passed explicitly. `--allow-missing` downgrades the "no ready/retired asset" case to an exit-0 skip (`skipped: no sellable asset yet`); an explicit `--asset-id` that is missing or wrong-status still errors.

**CI:** `.github/workflows/post-deploy-smoke.yml` runs this probe daily (and on dispatch). While repo variable `PRINT_SMOKE_STRICT` is unset/false it passes `--allow-missing` (pre-launch green skip); set `PRINT_SMOKE_STRICT=true` after the first `ready` asset so a missing asset fails the run. Restricted to the `main` branch. It needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `PRINT_ASSET_TOKEN_SECRET` as GitHub repo secrets — a second copy of those credentials, so prefer the narrowest viable key and keep the schedule infrequent until the gate is real.

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

### Production migration sync (`publish_actor_email`)

**When:** 2026-07-12 (evening). **Project:** `ceramics` (`wnlysejenowymjdxlnaq`, eu-west-1).

Audited via Supabase MCP (`list_migrations` + `execute_sql` on `pg_proc`). Compared 36 local files under `supabase/migrations/` against the remote migration history.

**Before apply:** `publish_print_asset_revision` on production had only three arguments (`p_product_id`, `p_revision`, `p_assignments`). The publish CLI's `--actor` / `p_actor_email` path from PR #147 was not live.

**Applied:** `supabase/migrations/20260712120000_publish_actor_email.sql` via MCP `apply_migration` (recorded remotely as `20260712193555_publish_actor_email`). Drops the 3-arg OID and recreates the function with trailing `p_actor_email text default null`; audit insert uses `coalesce(nullif(p_actor_email, ''), nullif(current_setting('app.actor_email', true), ''))`.

**After apply (verified):**

```sql
-- pg_get_function_arguments(publish_print_asset_revision)
p_product_id text, p_revision text, p_assignments jsonb,
p_actor_email text DEFAULT NULL::text
```

**No other repo migrations were pending.** Earlier print-pipeline DDL was already on production under different timestamp prefixes (same names, applied outside `supabase db push`):

| Repo file prefix | Remote `schema_migrations` version | Name |
| --- | --- | --- |
| `20260709130000` | `20260709085801` | `showroom_drops` |
| `20260709140000` | `20260709183732` | `catalog_shadow` |
| `20260710120000` | `20260710132930` | `catalog_audit_log` |
| `20260711120000` | `20260711131330` | `print_fulfilment_assets` |

**Prod-only (no local file):** `20260709075434_schema_hardening` — already applied previously; no action taken.

**Migration timestamp policy:** Local files under `supabase/migrations/` use repo-authored prefixes; production may record a different `schema_migrations.version` when DDL was applied via Supabase Dashboard/MCP (`apply_migration`) instead of `supabase db push`. That divergence is **accepted** for this project — the table above is the operator map. Do **not** rename local migration files to match remote timestamps (breaks fresh clones that already applied the local prefix). Fresh environments: use `supabase db pull` / MCP `list_migrations` to reconcile, or apply pending files in timestamp order and accept one-time prefix skew on already-live projects.

**Operator impact:** `npm run print-assets:publish -- … --actor you@studio` now records `catalog_audit_log.actor_email` on production. No app redeploy required for this DDL change.

### Legacy R2 inventory (`{productId}/master.jpg`)

Run: `npm run print-assets:inventory` (requires `wrangler login` / valid Cloudflare API token).

**Retention plan (Rollout §6):** keep legacy objects for one release window after cutover; no code path selects them (`process-job.ts` signs snapshotted `assetId` only — no `printAssetKey()` / WebP fallback). `printAssetKey()` remains for inventory CLI only.

| Design | Legacy key | Status (operator) |
| --- | --- | --- |
| fap01 | `fap01/master.jpg` | present (2026-07-13 inventory) — retain one release window |
| fap02 | `fap02/master.jpg` | present (2026-07-13 inventory) — retain one release window |
| fap03 | `fap03/master.jpg` | present (2026-07-13 inventory) — retain one release window |

**2026-07-13 run:** `npm run print-assets:inventory` — 3/3 legacy masters present in `anna-ciok-print-assets`. New pipeline objects live under `prints/{productId}/2026-07-12-r1/` (fap01: 7 content-addressed JPGs). No code path reads legacy keys; safe to delete after one release window post-live cutover.

### `fap01` distinct print-area profiles (sandbox matrix)

Seven profiles in `config/print-assets/fap01.json`. Place **one sandbox order per profile** (representative variant — not every frame colour when binaries share a profile).

**Passed run `2026-07-13-1017`** (BFM off + WAF skip live; assets visible in Prodigi sandbox dashboard):

| Profile | Representative variant | Prodigi SKU | `prodigi_order_id` | Download |
| --- | --- | --- | --- | --- |
| `3600x4800` | `30x40:false:false:none` | `GLOBAL-FAP-12X16` | `ord_1162949` | Complete |
| `3614x4795` | `30x40:true:false:black` | `GLOBAL-CFP-12X16` | `ord_1162950` | Complete |
| `2400x3600` | `30x40:true:true:black` | `GLOBAL-CFPM-12X16` | `ord_1162951` | Complete |
| `6000x8400` | `50x70:false:false:none` | `GLOBAL-FAP-20X28` | `ord_1162952` | Complete |
| `4800x7200` | `50x70:true:true:black` | `GLOBAL-CFPM-20X28` | `ord_1162953` | Complete |
| `8400x12000` | `70x100:false:false:none` | `GLOBAL-FAP-28X40` | `ord_1162954` | Complete |
| `7200x10800` | `70x100:true:true:black` | `GLOBAL-CFPM-28X40` | `ord_1162955` | Complete |

Matrix automation (sandbox only — uses production signed asset URLs; each run gets a unique UTC `runId` so Prodigi creates fresh orders):

```bash
npm run print-assets:sandbox-matrix -- --product fap01
npm run print-assets:sandbox-matrix -- --product fap01 --dry-run
npm run print-assets:sandbox-matrix -- --product fap01 --run-id 2026-07-13-r3   # optional override
```

Destructive E2E (one profile smoke — not full matrix):

```bash
PLAYWRIGHT_BASE_URL=<preview> E2E_DESTRUCTIVE=1 E2E_PRODIGI_SANDBOX=1 \
  npx playwright test e2e/print-purchase.spec.ts --grep @destructive
```

Per-profile orders: storefront checkout, `npm run print-assets:sandbox-matrix`, or `npm run prodigi -- order create` (sandbox only). Verify: `npm run prodigi -- order get <id>`, Prodigi sandbox dashboard, HEAD ETag/size vs manifest (`npm run print-asset:smoke`).

**Earlier failed runs (archived):** `ord_1162923`–`ord_1162929` and `ord_1162935`–`ord_1162941` — `downloadAssets: Error` while Bot Fight Mode was on (`managed_challenge` / `botFight` in Security Events). Not valid proof; cancel in sandbox if still open.

### Live rollout approval

**Status:** _sandbox matrix passed 2026-07-13_ (`ord_1162949`–`ord_1162955`, run `2026-07-13-1017`) — assets confirmed in Prodigi sandbox dashboard. **Remaining before `PRODIGI_ENV=live`:** studio visual sign-off on `design/print-assets/fap01/2026-07-12-r1/proof-*.jpg` + explicit operator PR sign-off. Keep Bot Fight Mode **off** on Free (or upgrade to Pro + Super Bot Fight Mode with per-path WAF skip if bot protection must stay on).

## Configurator mockups (`print-assets:mockups`)

Pre-rendered hero states for the PDP live-mockup feature (spec
`docs/superpowers/specs/2026-07-19-print-configurator-live-mockup-design.md`).

Prerequisites: the design's fulfilment revision is published (`ready`);
`config/print-assets/frames.json` exists (copy `frames.example.json`) and its
`file` entries point at the six frame masters under gitignored
`design/print-assets/frames_blanks/` — opaque mockup blanks (baked background
+ shadow, ≥2000 px canvas; PNG preferred, JPG tolerated), one framed + one
mount blank per colour (black / natural / brown). Mount blanks follow the
recipe: window filled white, centred aperture at 85.7% × 90% of the window
(ratio 0.667 = CFPM sheet), 2–4 px light-grey bevel edge + subtle inner
shadow. The `window` values in frames.json are fractions of each master's own
canvas; the sheet is composited over that rect.

    npm run print-assets:mockups -- --product fap01 --dry-run   # inspect plan
    npm run print-assets:mockups -- --product fap01             # compose + upload + mirror

The step composes the `8400x12000` FAP derivative (framed states) and the
`7200x10800` CFPM derivative (mount states) into the colour's frame master,
then emits `public/uploads/<stem>-mock-<state>.webp` + 400/800/1600w srcset
variants and mirrors them to R2 (`prints/{product}/gallery/mock-<state>/`).

Ship in ONE PR: the generated `public/uploads/*-mock-*.webp` files **and**
`mockups: true` on the design in `src/lib/prints.ts` (the PDP only swaps the
hero when the flag is set). Re-run after every new fulfilment revision, like
`print-assets:gallery`.
