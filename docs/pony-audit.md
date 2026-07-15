# Ponytail over-engineering audit

**Date:** 2026-07-14
**Scope:** whole repo (`src/`, `scripts/`, `worker.ts`)
**Method:** `ponytail:ponytail-audit` — three parallel Explore agents (domain / server+scripts / app+admin) + direct source verification. Findings ranked biggest cut first.

## Verdict

Dependencies are already lean (no lodash / date-fns / clsx to cut — the `stdlib`/`native` wins below replace hand-rolled code with builtins, not packages). The real bloat is concentrated in **(a) USD/CAD currency scaffolding** and **(b) the `scripts/` + Prodigi-client layer** (duplicated env/arg parsing, speculative operator methods, a contract-smoke harness that tests itself). The `src/app` + admin + cart surfaces are genuinely disciplined — little to cut.

> ⚠️ **Important correction.** The audit initially flagged the `CATALOG_SOURCE` DB catalog and the async product accessors as speculative scaffolding (and AGENTS.md still describes them that way). That is **wrong**. `wrangler.jsonc` sets `"vars": { "CATALOG_SOURCE": "db" }` in production, and `src/lib/products.ts:334-335` is in the live import graph (`loadCeramicProductsFromDb` → `readCeramicProducts(getSupabaseAdmin())`). The async accessors do real Supabase I/O. See **Retracted** below.

---

## Tier 1 — biggest ROI, genuinely deletable

### 1. `yagni` — USD/CAD currency scaffolding (dead in every live path) · ~75 LOC + 7 call sites
The display currency is clamped to `pln`/`eur`/`gbp` at every entry point (`SWITCHABLE_CURRENCIES = ['eur','gbp']`, `SELLABLE_CURRENCIES = ['pln','eur','gbp']`, `toChargeableCurrency` maps usd/cad→eur, `displayCurrencyFromCookieValue` rejects them), so usd/cad never reach pricing.
- `src/lib/pricing.ts` — `PRICE_USD`/`PRICE_CAD` all-`null` tables (`:107-131`); `priceOfCurrency` usd/cad `throw`-branches (`:174-183`, unreachable); `toUSDCents`/`toCADCents` (`:133-141`, **0 callers — pure delete**).
- `src/lib/currency.ts` — `toChargeableCurrency` (`:63-65`) exists only because usd/cad exist → unwinds at 7 call sites; `Currency` union `'usd'|'cad'`; `VALID_CURRENCIES` usd/cad entries.
- `src/lib/format.ts` — `usd()`/`cad()` formatters + `currencyFormatter` usd/cad cases; `CurrencyCode 'USD'|'CAD'`.
- `src/components/layout/CurrencySwitcher.tsx` — `usd`/`cad` label-map entries (the file's own comment says "never shown").
- **Replace with:** delete `'usd'|'cad'` from `Currency`; the rest unwinds mechanically.
- *Caveat: AGENTS.md calls this intentional pre-launch staging — your call, but it's textbook YAGNI.*

### 2. `stdlib`/`shrink` — Nine hand-rolled dotenv parsers despite a shared helper · ~140 LOC
A shared helper already exists (`scripts/lib/script-env.ts` `parseEnvFile` / `loadLocalEnv`, with the `.env.local` → `.dev.vars` → `--env-file` → env precedence). Eight other files reimplement it; the two big CLIs ship **byte-identical** copies (`parseEnvText` verified identical via `diff`).
- `scripts/prodigi-cli.ts:169/187/197` & `scripts/orders-cli.ts:129/147/158` (identical `parseEnvText`).
- `scripts/check-print-fulfilment-jobs.ts:16`, `sync-prodigi-skus.ts:29`, `create-drop.ts:19/37`, `export-inpost-bulk-csv.ts:49/67`, `create-private-sale-link.ts:22/40`, `backfill-catalog.ts:19/37`, `debug-meta-capi.mjs:39/59`.
- **Replace with:** route all of these through the existing `scripts/lib/script-env.ts`.

### 3. `stdlib` — Eight hand-rolled arg parsers ignoring `node:util parseArgs` · ~120 LOC
`prodigi-cli.ts` and `orders-cli.ts` already use `node:util`'s `parseArgs`. Every other script reinvents `--flag value` / `--flag=value` parsing.
- `scripts/lib/print-assets-cli.ts:18/34` (`getArg`/`hasFlag`, used only by the print-assets trio); per-script `parseArgs()` in `prodigi-contract-smoke.ts:33`, `print-assets-sandbox-matrix.ts:15`, `print-asset-smoke.ts:63`, `create-drop.ts:45`, `export-inpost-bulk-csv.ts:75`, `create-private-sale-link.ts:49`, `debug-meta-capi.mjs:67`, `generate-product-notes.mjs:33`, `reconcile-orders.mjs:396`.
- **Replace with:** one `parseArgs({ options, allowPositionals })` call per script.

### 4. `yagni` — Speculative Prodigi client methods + CLI commands (never hit by any live path) · ~160 LOC
The live fulfilment/callback/cancel surface uses exactly four client methods: `postOrder`, `getOrder`, `getOrderActions`, `cancelOrder`. The rest are called **only from `scripts/prodigi-cli.ts`**.
- `src/server/prodigi/client.ts` — `listOrders` + `orderListPath` query builder (`:78-106`); `updateShippingMethod`/`updateRecipient`/`updateMetadata` (`:114-136`); `getProduct`/`postQuote`/`postSpine` (`:138-145`).
- `src/server/prodigi/types.ts` — supporting types for the above (`:64-142`).
- `scripts/prodigi-cli.ts` — `quote`/`spine`/`order list`/three `update-*` command handlers + schemas.
- **Replace with:** nothing — features-for-later. Read/cancel ops (`order get/cancel/actions`, `product get`) are defensible operator tools.

---

## Tier 2 — real, judgment calls

### 5. `shrink` — Two CLIs duplicate an entire DI/testing scaffold · ~150 LOC duplicated
`prodigi-cli.ts` and `orders-cli.ts` each carry their own **identical** copy of: `CliError`, `CliDependencies`, `defaultDependencies`, env parsing, the `{ ok, environment, data }` envelope, and graded exit-code handling — all present only so the CLIs are unit-testable.
- **Replace with:** dedupe the shared bits (`CliError` + envelope at minimum). Do **not** add a new shared base class (that would be a new abstraction); the minimal shrink is the genuinely-shared primitives, or accept the two CLIs as siblings.

### 6. `yagni`/`shrink` — Contract-smoke harness tests the test, not the contract · ~140 LOC
The contract smoke's reason to exist is hitting the **real sandbox**. Yet the orchestrator was split out and given a hand-transcribed interface purely so it can be unit-tested against fakes.
- `src/server/prodigi/contract-smoke.ts` — `ContractClient` one-implementation interface (`:8-14`); `ContractSmokeDeps` + `mapStage` injection (`:16-21`, comment admits it exists "so the orchestrator is unit-testable without status-map").
- `src/server/prodigi/contract-smoke.test.ts` (134 LOC, 8 tests) — asserts the harness interprets hand-built fakes; the `mapStage` injection is a `vi.fn`, so it proves nothing about the real `mapProdigiStage`.
- **Replace with:** inline `runProdigiContractSmoke`'s body into `scripts/prodigi-contract-smoke.ts`'s `main()` (it already imports the real `mapProdigiStage`/`prodigiClient`/`buildProdigiPayload`); drop the interface, deps type, and the `.test.ts`. The runner *is* the integration test; the sandbox run is the assertion.
- The CI workflow (`workflow_dispatch`-only) and runbook are proportionate and stay.
- **Owner-gated, not a default cut.** `docs/cleaning-instructions.md` defers this (Tier C). The orchestrator's injected-`mapStage` tests give *deterministic* error-path coverage — each drift case, cancel-guarantee on every path, cancel-throws, merchantReference round-trip — that a single sandbox run cannot reproduce (and the runner uses the real `mapProdigiStage`, so the wire-up is proven end-to-end by the dispatch). Do not inline without owner sign-off; the unit tests and this PR's H-1 smoke are complementary, not redundant.

---

## Tier 3 — trivial, unambiguous

### 7. `stdlib`/`shrink` — Five identical `Math.round(n*100)` wrappers → one `toMinor` · ~10 LOC
`src/lib/pricing.ts` — `toGrosze`/`toEuroCents`/`toGBPPence` (live) + `toUSDCents`/`toCADCents` (dead, see #1). All wrap the same stdlib one-liner with different parameter names. **Replace with:** one `const toMinor = (n) => Math.round(n * 100)` (or inline at the 6 call sites in `checkout/route.ts` + `checkout.ts`).

### 8. `native` — Hand-rolled timing-safe-equal while `nodejs_compat` is on · ~11 LOC
`wrangler.jsonc:10` enables `nodejs_compat`, so `node:crypto.timingSafeEqual` is available at runtime. `src/lib/timing-safe-equal.ts:7-12` reinvents it. Node's is the audited canonical impl. **Caveat:** security boundary — Node's throws on unequal length (this one returns `false`), so call sites need adjustment before swapping. Verify first.

### 9. `delete` — micro-dupes
- `src/server/prodigi/mapper.ts:46` — `printItemAssetKey` is a one-line wrapper over `item.variant.assetId` with a single caller (`process-job.ts:170`). Inline. (~3 LOC.)
- `runId()` / `defaultRunId()` — identical (`${iso.slice(0,10)}-${iso.slice(11,16).replace(':','')}`) in `scripts/prodigi-contract-smoke.ts:51` and `scripts/print-assets-sandbox-matrix.ts:35`. One shared helper. (~4 LOC.)
- `localizedPath` — defined twice, identical body, in `src/app/api/admin/content/publish/route.ts:12` and `.../preview/route.ts:10`. (~2 LOC.)
- `UUID_RE` — duplicated in `src/app/api/checkout/route.ts:25` vs `src/lib/admin/data.ts:13` (which exports `isUuid`). (~1 LOC — note: sharing couples checkout to the admin lib; inlining is cleaner.)

---

## Retracted — checked, NOT over-engineered (recorded so this isn't re-litigated)

- **`CATALOG_SOURCE` DB catalog seam / "premature async" / parallel `registry*` accessors** — **LIVE in production** (`wrangler.jsonc` vars = `db`). The async accessors genuinely `await` Supabase reads via `loadCeramicProductsFromDb`; `loadCeramicCatalog`'s `code` branch is the local-dev/test fallback (CATALOG_SOURCE unset locally). The `registry*` sync helpers are used by client components (`CartView`, `SelectionBar`) and code-derived surfaces (`invoice.ts`, `packing.ts`, `analytics.ts`, `cms/schemas.ts`, admin labels) that can't call the service-role client. Justified duplication, not deletable.
- **Admin dual client factories + injected `supabase` param** — `adminSupabase()`/`adminStripe()` serve request-context routes; `adminSupabaseFromEnv()`/`adminStripeFromEnv()` serve `scripts/orders-cli.ts` + `export-orders-csv.ts` (no request ALS). The injected `supabase` in `data.ts` is exercised at `orders-cli.ts:316/373/383` and `export-orders-csv.ts:106`. Justified seam.
- **"Thin" `/api/admin/*` adapters** — each carries real per-route dep wiring + logic (e.g. `label/route.ts:14-37` runs its own Supabase query + InPost call; `end-drop`, `toggle-showroom`, `content/*` do DB writes + revalidation). Collapsing would *add* an abstraction. `actions.ts` is genuinely shared (4 routes + orders-cli). Justified.
- **Cart store** — `src/store/cart.ts` is 32 lines, no quantities / server sync / merge logic. Minimal.

---

## Non-code weakness — highest ROI per unit effort

**Stale docs actively mislead.** AGENTS.md states the DB catalog is "scaffolded… not yet the production source" and that `code` is the "live default" — both **false** now that `wrangler.jsonc` sets `db`. Inline comments in `src/lib/catalog/source.ts` ("NOT yet wired into the storefront accessors"), `src/lib/catalog/load.ts` ("does NOT wire them into the storefront accessors — that async cutover is Stage 3b"), and `src/lib/products.ts` say the same. This just caused the audit to nearly recommend deleting live production code. **Fix the doc lines (and the AGENTS.md paragraph)** — it prevents the next wrong deletion.

---

## Net

**Safe core (~−280 LOC):** env/arg parsing #2 + #3, ×100 wrappers #7, trivial dupes #9. **Owner-gated — NOT safe-core:** #4 (Prodigi client methods, ~160 LOC — used by `scripts/prodigi-cli.ts`; see `docs/cleaning-instructions.md` Tier C / rule #5) and #6 (this PR's H-1 contract-smoke harness — deferred). **Up to ~−850 LOC** if USD/CAD #1, CLI-dedup #5, #4, #6, and the native `timingSafeEqual` swap #8 are also accepted. **−0 deps** — the manifest is already lean.

Recommended first chunk: #2 + #3 + #7 + #9 (highest confidence, lowest risk, mechanical). Verify with `npm run typecheck && npm run test`.
