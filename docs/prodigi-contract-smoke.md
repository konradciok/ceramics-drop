# Prodigi v4 contract smoke (audit H-1)

A manually-triggered workflow that proves the Prodigi v4 contract still round-trips
through the **real** production code path — `buildProdigiPayload()` →
`prodigiClient.postOrder()` → `getOrder` → `getOrderActions` → `mapProdigiStage` →
`cancelOrder` — against the Prodigi **sandbox**. It exists because every other
Prodigi test is hand-mocked, so schema drift (a renamed field, a changed enum, a
new required field, a renamed `status.stage`) would break print fulfilment while
`npm test` and CI stayed green.

Design: `docs/superpowers/specs/2026-07-13-prodigi-contract-smoke-design.md`.

## Run it

### Locally

```bash
npm run prodigi:contract-smoke -- --env-file .dev.vars
# optional: --product fap01   pick the print design (default fap01)
#           --strict          fail instead of skipping when no usable asset exists
#           --json            emit only the JSON report
```

Requires in `.dev.vars` / `--env-file` / env: `PRODIGI_API_KEY_SANDBOX`,
`PRINT_ASSET_TOKEN_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
optionally `WORKER_ORIGIN` (defaults to the production origin).

The runner is **sandbox-only**: it hard-sets `PRODIGI_ENV=sandbox` and loads only
the sandbox key. It can never reach the live API.

### In CI

GitHub → Actions → **prodigi-contract-smoke** → Run workflow (on `main`).
`workflow_dispatch` only — it is never run on PRs or a schedule.

## What a green run proves

For one usable print asset, Prodigi's sandbox **accepted** the exact payload
`buildProdigiPayload` produces (so no required field was added/renamed), and our
code **accepted** Prodigi's responses: `order.id`, `order.status.stage`,
`order.items[0].id`+`.sku`, `cancel.isAvailable === 'Yes'`, the real `status.stage`
maps via `mapProdigiStage`, and `cancelOrder` returned `Cancelled`. Every created
order is cancelled in `finally` (self-cleaning; sandbox is free, but no litter).

## What a red run means

The JSON report's `steps[]` names the first failing step + a `reason`:

| Failing step | Meaning | First place to look |
|--------------|---------|---------------------|
| `create:*` | Prodigi rejected our payload (or renamed a field) | `src/server/prodigi/mapper.ts`, Prodigi v4 `POST /orders` docs |
| `getOrder:*` | `GET /orders/{id}` shape changed | `ProdigiOrderResponse` in `src/server/prodigi/types.ts` |
| `actions:cancel` | Cancel is no longer an available action | Prodigi actions docs; `cancelOrder` in `client.ts` |
| `mapStage` | Prodigi renamed a `status.stage` we depend on | `mapProdigiStage` in `src/server/fulfilment/status-map.ts` |
| `cancel` | The order was created but didn't cancel — **check the sandbox dashboard and cancel manually** | Prodigi sandbox dashboard |

A `mapStage` failure is the highest-signal one: it means a callback would no
longer advance the fulfilment job. Fix the mapping in `status-map.ts` and add the
new string to its test.

## Secrets

The workflow needs `PRODIGI_API_KEY_SANDBOX` as a GitHub repo secret, plus the
existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PRINT_ASSET_TOKEN_SECRET`
(already used by `post-deploy-smoke`). To rotate the sandbox key: generate a new
one in the Prodigi sandbox dashboard, update the repo secret, done — no code
change.

## Scope and limits

- **One variant per run**, not the full print-area matrix — this is a *contract*
  check, not per-variant acceptance (that is `npm run print-assets:sandbox-matrix`).
- **No production DB writes.** Callback coverage is `mapProdigiStage(realStage)`
  only; the full `handleProdigiCallback` is not replayed (it mutates prod tables).
- **`callbackUrl` noise:** the payload carries the production webhook URL, so a
  created sandbox order *could* deliver a callback for a phantom `merchantReference`.
  Cancelled sandbox orders do not emit callbacks in practice, and the handler
  returns a harmless 500 + releases its lease. Noise is negligible.
- **Pre-launch skip:** with `PRODIGI_SMOKE_STRICT` unset, a missing usable asset is
  an exit-0 skip (mirrors `print-asset:smoke`). Set `PRODIGI_SMOKE_STRICT=true`
  once a print asset is published.
