# Prodigi v4 contract smoke (audit H-1)

Status: Approved (brainstormed 2026-07-13). Implements finding **H-1** of
`docs/superpowers/specs/2026-07-13-prodigy-audit.md` (Missing test scenarios #1,
remediation item 8).

## Context

H-1: no test ever touches the real Prodigi v4 API. Every interaction in the suite
is hand-mocked; `mapper.test.ts` asserts payloads against our *own* expectations,
`client.test.ts` stubs `fetch`. Prodigi schema drift (a renamed `sizing` value, a
changed attribute key, altered cancel-outcome casing, a new required field, a
renamed `status.stage`) silently breaks print fulfilment while `npm test` and CI
stay green. A paid print order submitted in a shape Prodigi now rejects →
`failed_action_required` → silent backlog until a customer complains.

### Smoking gun that makes this worth doing

The closest existing "real-API" operator script,
`scripts/print-assets-sandbox-matrix.ts`, **hand-rolls the order payload and calls
`fetch` directly** (lines 67–113). It never imports `buildProdigiPayload()` and
never calls `prodigiClient(env).postOrder()`. The production fulfilment path —
the exact code `processJob` runs against a paid order — has therefore never been
exercised against real Prodigi by anything in the repo. The contract smoke exists
to close that gap.

## Decision (confirmed with the operator)

- **Live-sandbox smoke first.** A `workflow_dispatch` job drives a real
  create→inspect→cancel lifecycle against the Prodigi **sandbox** through the real
  mapper + client. Faithful to the current schema; reuses the established
  `print-asset:smoke` + `post-deploy-smoke.yml` pattern.
- **Recorded fixtures (msw/nock) are deferred** to an optional later follow-up for
  fast per-PR mapper-shape regression. Not built here. (Fixtures go stale silently
  — the exact failure mode H-1 warns about — so the live smoke is the source of
  truth, not the fixtures.)
- **Real production signed asset URL** in the order payload (as
  `print-assets-sandbox-matrix` does), so Prodigi downloads the same bytes
  checkout would send. Adds no new external URL that can rot.
- **Callback coverage = status-string mapping only.** We do *not* replay a
  CloudEvents body through `handleProdigiCallback` (it mutates prod
  `webhook_events` / `prodigi_orders` / `fulfilment_jobs` and can send email). We
  instead feed the real sandbox order's `status.stage` through `mapProdigiStage()`
  and assert it resolves to a known local stage. This captures the callback-relevant
  contract (real status strings are ones we recognise) with zero DB writes.

## Architecture

Mirrors the `print-asset:smoke` trio: **pure-ish core in `src/server/`** (testable,
dependency-injected), **thin `tsx` runner in `scripts/`**, **workflow in
`.github/workflows/`**.

### Files

1. **`src/server/prodigi/contract-smoke.ts`** — `runProdigiContractSmoke(deps)` and
   result types. `deps` injects the client methods (`postOrder`, `getOrder`,
   `getOrderActions`, `cancelOrder`), the payload inputs (already-built
   `ProdigiOrderRequest`), and `mapStage` (= `mapProdigiStage`). The function
   drives the lifecycle, returns a structured `SmokeResult`, and **always cancels
   the created order in `finally`** — even when an assertion fails. No `fetch`
   here; it goes through the injected client, so a unit test can feed a fake. DI
   style matches `CliDependencies.clientFactory` and the admin action DI.

2. **`scripts/prodigi-contract-smoke.ts`** — thin runner mirroring
   `scripts/print-asset-smoke.ts`: `loadLocalEnv()` → sandbox-only guard → resolve
   one usable print asset → mint a production signed URL → assemble a shape-correct
   `OrderRow` + `PrintItemRow[]` → build the payload via the **real**
   `buildProdigiPayload()` → call
   `runProdigiContractSmoke({ client: prodigiClient(env), payload, mapStage })` →
   print a JSON report → set `process.exitCode`.

3. **`src/server/prodigi/contract-smoke.test.ts`** — vitest. A fake client returns
   (a) a well-shaped response and (b) drift-shaped responses (missing `order.id`,
   renamed `status.stage`, `cancel.isAvailable: 'No'`, lowercase `'cancelled'`).
   Asserts the success path passes, each drift case fails with a clear reason, and
   **`cancelOrder` is always called** (cleanup guarantee) — including after an
   assertion failure and on the success path.

4. **`.github/workflows/prodigi-contract-smoke.yml`** — mirrors
   `post-deploy-smoke.yml`: `workflow_dispatch` on `main`, **no schedule**,
   `actions/checkout` (default branch, `persist-credentials: false`), `setup-node`
   22, `npm ci`, then `npm run prodigi:contract-smoke`. Secrets: a new
   `PRODIGI_API_KEY_SANDBOX` repo secret, plus the existing `SUPABASE_URL` /
   `SUPABASE_SERVICE_ROLE_KEY` / `PRINT_ASSET_TOKEN_SECRET`. `permissions:
   contents: read`. `timeout-minutes: 10`.

5. **`package.json`** — one script:
   `"prodigi:contract-smoke": "tsx scripts/prodigi-contract-smoke.ts"`.

6. **Docs** — `docs/prodigi-contract-smoke.md` runbook (how to run, what a failure
   means, how to rotate the secret), and a one-line entry in the AGENTS.md
   commands list alongside `npm run prodigi`.

No new dependencies (the smoke is a live HTTP call through the existing client +
`tsx`, both already in use). **No changes to `src/server/prodigi/client.ts`** —
`cancelOrder`, `getOrder`, and `getOrderActions` already exist.

## The contract (what the assertions check)

These are the fields `processJob` and `handleProdigiCallback` actually read. A
drift in any of them is the silent-failure mode H-1 describes.

| Step | Call | Assertion |
|------|------|-----------|
| Create | `client.postOrder(payload)` | `outcome` present; `order.id` non-empty string; `order.status.stage` is a string; `order.items[0].id` and `.sku` present |
| Inspect | `client.getOrder(order.id)` | `order.id` === created id; `order.status.stage` is a string |
| Actions | `client.getOrderActions(order.id)` | `cancel.isAvailable === 'Yes'` (cancel is still an exposed Prodigi action — drift here breaks our cancel path) |
| Status map | `mapStage(realStage)` | returns non-`null` (drift signal: Prodigi renamed a stage `processJob`/callbacks depend on) |
| Cancel | `client.cancelOrder(order.id)` | `outcome` case-insensitive equals `'cancelled'` (audit noted Prodigi's own docs disagree on casing) |

Each assertion, on failure, produces a `{ ok: false, step, reason }` entry naming
the field/stage that drifted. The runner exits non-zero; the workflow goes red.

## Lifecycle (runner)

1. Load env (`loadLocalEnv`). **Hard-set `PRODIGI_ENV: 'sandbox'`**; never read
   `PRODIGI_ENV` from files (mirrors `prodigi-cli` using only the explicit key).
2. Guard: abort loudly if `PRODIGI_API_KEY_SANDBOX` is absent, or if
   `PRINT_ASSET_TOKEN_SECRET` / Supabase creds are absent.
3. Resolve one **usable** print asset — `ready` **and** dimension-matched to its
   variant's print area (reuse the existing `resolvePrintAsset(productId,
   variantKey)` resolver, whose `isUsable` check guarantees the mapper's
   `assertSnapshotDimensions` will pass; fall back across published designs until
   one usable asset is found). `--allow-missing` downgrades "no usable asset" to an
   exit-0 skip, mirroring `print-asset:smoke` (so the workflow is green pre-launch).
4. Mint a production signed URL for that asset (`signPrintAssetUrl` against the prod
   origin, as `print-assets-sandbox-matrix` does).
5. Assemble a shape-correct `OrderRow` (sentinel `id` = `contract-smoke-<runId>`,
   sandbox PL shipping address, currency `pln`) and one `PrintItemRow` (variant
   block from the prints registry: `prodigiSku`/`framed`/`mount`/`frameColour`/
   `printAreaPx`; asset fields `assetId`/`assetKey`/`assetSha256`/
   `assetContentType`/`assetWidthPx`/`assetHeightPx` from the resolved asset row).
6. Build the payload via the **real** `buildProdigiPayload(order, items, assetUrls,
   env)`.
7. `runProdigiContractSmoke({ client: prodigiClient(env), payload, mapStage })`.
8. Print JSON report; set exit code from the result.

`runProdigiContractSmoke` internally: postOrder → (capture `order.id`) → getOrder →
getOrderActions → mapStage → assert each → `finally { cancelOrder }` → assert
cancel outcome. The `order.id` is captured immediately after a successful create so
the `finally` can cancel even if a later step throws.

## Safety (non-negotiable)

- **Sandbox only.** The runner hard-codes sandbox; the guard aborts if it could
  resolve to live. The client is constructed with `PRODIGI_ENV: 'sandbox'` and the
  sandbox key only. Live keys are never read by the smoke.
- **Sandbox key is a CI secret** (`PRODIGI_API_KEY_SANDBOX`), never committed. The
  job is `workflow_dispatch` (manual), never per-PR, never scheduled.
- **Cancel every created order.** The orchestrator cancels in `finally`; the unit
  test proves it fires on every path (success, assertion failure, network throw).
- **No real charge.** Sandbox orders are free; the order is cancelled immediately.
- **No production DB mutation.** Status-mapping-only callback coverage (above)
  means the smoke never writes to `webhook_events` / `prodigi_orders` /
  `fulfilment_jobs`.

## Deliberate scoping decisions (flagged, not hidden)

1. **No full `handleProdigiCallback` replay.** Out of scope — it mutates prod tables
   and can send email. Real status-string mapping via `mapProdigiStage` is the
   in-scope callback contract. The handler's own fidelity is covered by
   `callbacks.test.ts`.
2. **`callbackUrl` noise.** `buildProdigiPayload` embeds the production webhook URL
   (`/api/webhooks/prodigi/<token>`), so a created sandbox order *could* deliver a
   callback for a phantom `merchantReference`. We keep the real `callbackUrl`
   because it is part of the contract (stripping it would dodge the noise but stop
   testing that field). In practice cancelled sandbox orders do not emit callbacks,
   and the handler returns a harmless 500 ("No local order") that releases its
   lease. Noise is negligible and self-cleaning. Documented here and in the runbook.
3. **One variant, not the matrix.** This is a *contract* smoke, not a per-print-area
   coverage run (that is `print-assets:sandbox-matrix`). One representative usable
   variant proves the API shape; the matrix script already covers per-profile
   acceptance.

## Out of scope / deferred

- Recorded-fixture mapper-shape test (msw/nock) — optional later follow-up for
  fast per-PR regression. The live smoke is the contract source of truth.
- H-2 (paid print order → fulfilment-state E2E assertion) — separate finding.
- M-3 / M-4 / M-5 (queue disposition, idempotency pgTAP, DLQ alerting) — shipped
  (M-3) or separate.

## Definition of done

- A `workflow_dispatch` workflow that, against the real Prodigi sandbox, proves
  `buildProdigiPayload()` → `prodigiClient.postOrder()` → response parse →
  `getOrder` → `getOrderActions` → `mapProdigiStage` → `cancelOrder`, sandbox-key
  backed and self-cleaning (cancel in `finally`).
- Fails loudly (red workflow + a `{ step, reason }` message naming the drifted
  field/stage) on schema drift.
- `docs/prodigi-contract-smoke.md` runbook + AGENTS.md command entry.
- `npm run typecheck` clean; `npm test` green (existing suite + the new
  `contract-smoke.test.ts`).

## Implementation note (the one detail to nail in the plan)

Assembling a shape-correct `PrintItemRow` so the real `buildProdigiPayload`
accepts it (and its `assertSnapshotDimensions` does not throw). The path is already
determined: reuse `resolvePrintAsset(productId, variantKey)` — its `isUsable` check
guarantees `asset.width_px === variant.print_area_width_px` (and height), which is
exactly the equality `assertSnapshotDimensions` enforces. The variant metadata
(`prodigiSku`, `framed`, `mount`, `frameColour`, `printAreaPx`) comes from the
prints registry / `PRODIGI_SKU_MAP` keyed by the same `variant_key`. The plan
specifies the exact resolver + registry calls and the `--allow-missing` skip path.
