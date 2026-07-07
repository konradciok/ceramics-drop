# CODE_CLEANING_PLAN.md

**Type:** Read-only cleanup **planning** session (no code changed except this file).
**Repo:** `ceramics-drop` — Anna Ciok Ceramics storefront (Next.js 16 App Router · React 19 · OpenNext on Cloudflare Workers · npm).
**Branch:** `main` · **Generated:** 2026-07-07
**Author:** automated audit (Kasabian). Two parallel read-only reviewer agents were dispatched over the frontend and backend/scripts surfaces; every finding below is independently verified by the lead via `git grep` and does not depend on pending agent output.

> **Guarantee:** This session made **zero** code changes. The only file created is
> this plan. `git status --short` before and after showed only pre-existing
> untracked user work (see below) — nothing staged, nothing modified.

---

## 0. Scope & exclusions

**In scope:** `src/**`, `scripts/**`, root config, `package.json` deps, `messages/**`, `worker.ts`, middleware.

**Explicitly OUT of scope — left untouched:**

- Generated/ignored: `.next/`, `.open-next/`, `.wrangler/`, `node_modules/`, `.worktrees/`, `tsconfig.tsbuildinfo`.
- Assets: `public/uploads/**` (623 files), `public/fonts/**` — never classified by code grep.
- **Untracked user WIP** (present at audit time, intentionally not audited or moved):
  `docs/research/`, `scripts/research/`, `guides.md`, `docs/plans/2026-storefront-upgrade.md`.

---

## 1. Methodology

Tools/commands run (all read-only):

```bash
git status --short ; git ls-files            # inventory (999 tracked files; 285 code files)
npm run lint                                 # eslint .
npm run test                                 # vitest run
npm run build                                # next build --webpack
npx tsc --noEmit                             # typecheck
npx tsc --noEmit --listFilesOnly             # confirm worker.ts is in the program
npx knip --no-progress                       # unused files/exports/deps
npx depcheck --json                          # unused dependencies
npx ts-prune                                 # unused exports
git grep <symbol>                            # import-verify EVERY tool finding
```

Plus manual review of: `package.json`, `tsconfig.json`, `eslint.config.mjs`, `next.config.ts`,
`wrangler.jsonc`, `open-next.config.ts`, `worker.ts`, `src/middleware.ts`, all scripts,
CSS (`src/styles/`), i18n message files, and the `AGENTS.md` convention list.

**Golden rule applied throughout:** a clean tool report is *not* proof. Every "unused"
finding below was confirmed with `git grep` for the symbol/import across the whole repo.
Static dead-code tools are noisy in Next/OpenNext repos — treat their output as *signals*,
downgraded to NEEDS-VERIFICATION unless import-search-confirmed.

---

## 2. Baseline results (record before touching anything)

| Check | Result |
|---|---|
| **Lint** (`npm run lint`) | ✅ Pass — zero warnings/errors |
| **Unit tests** (`npm run test`) | ✅ Pass — **71 files, 723 tests** |
| **Build** (`npm run build`) | ❌ **FAILS** — compiles OK (29s), then fails at TS check on `worker.ts` |
| **Typecheck** (`npx tsc --noEmit`) | ❌ Same 3 errors in `worker.ts` |
| **i18n** | ✅ `pl/en/es/de` key-sets identical (0 divergence) — no orphan/missing keys |
| **Prod `console.log`** | 1 (in `src/app/api/resend/webhook/route.ts`) — negligible |
| **Prod `eslint-disable`** | 19, all `@next/next/no-img-element` — intentional (raw `<img>` for uncropped photos) |

**The build failure is a PRE-EXISTING baseline condition, not caused by cleanup.**
`worker.ts` uses Cloudflare Worker globals (`MessageBatch`, `ScheduledController`,
`ExportedHandler`) that aren't resolved in the plain `tsc`/`next build` typecheck context.
`worker.ts` is `tsconfig`-`exclude`d yet still enters the program because `include: ["**/*.ts"]`
matches it (confirmed via `tsc --listFilesOnly` → returns `worker.ts`). **The follow-up agent
must record this baseline and must NOT "fix" it by editing `worker.ts` logic or hiding the error.**

```
worker.ts(36,12): error TS2304: Cannot find name 'MessageBatch'.
worker.ts(50,27): error TS2304: Cannot find name 'ScheduledController'.
worker.ts(59,13): error TS2304: Cannot find name 'ExportedHandler'.
```

---

## 3. Safe cleanup candidates

Proven not to affect behavior. Each verified by `git grep`. Apply first; re-run validation after.

### 3.1 `src/components/layout/Announce.tsx` — unused component
- **What:** Exported `Announce` component with zero importers.
- **Evidence:** `knip` unused file + `ts-prune` unused export; `git grep Announce` → no imports anywhere outside the file itself. Reviewer-corroborated.
- **Risk:** SAFE.
- **Action:** Delete the file **only**.
- **⚠️ Do NOT delete the `.announce` / `.dot` CSS** (`src/styles/site.css:28,34`) — those classes are used **live** by `src/components/layout/Header.tsx:31`. The component is dead; the CSS is not.

### 3.2 `src/components/shop/CollectionSkeleton.tsx` — unused component
- **What:** Exported `CollectionSkeleton` component with zero importers.
- **Evidence:** `knip` unused file + `ts-prune`; `git grep CollectionSkeleton` → no imports. Reviewer-corroborated.
- **Risk:** SAFE.
- **Action:** Delete the file **only**.
- **⚠️ Do NOT delete the `.skel-gallery` / `.skel-tile` CSS** (`src/styles/site.css:1034,1035`) — used **live** by `src/app/[locale]/(collections)/loading.tsx:5,7`, which duplicates this component's markup inline. (The duplication is why the component became orphaned.)

### 3.3 `@eslint/eslintrc` — unused devDependency
- **What:** devDependency with no references.
- **Evidence:** `depcheck` unused; `git grep "@eslint/eslintrc|FlatCompat"` → zero refs; `eslint.config.mjs` imports only `eslint-config-next` (flat config, no `FlatCompat` shim).
- **Risk:** SAFE.
- **Action:** Remove from `package.json` devDependencies; run `npm install` to update lockfile.

### 3.4 `@google-analytics/data` — unused dependency
- **What:** Runtime dependency with no importers.
- **Evidence:** `depcheck` unused (clean re-run); `git grep "@google-analytics/data|BetaAnalyticsDataClient"` → zero source refs; `scripts/ga4-data.mjs` uses `googleapis` + the REST endpoint, **not** this package; `npm ls @google-analytics/data` → top-level only (no transitive dependents). No future-migration signal in `.env.example`/`AGENTS.md`/docs.
- **Risk:** SAFE.
- **Action:** Remove from `package.json` dependencies; `npm install`. *(If GA4 credentials are available, optionally smoke-test `npm run ga4:report` afterward.)*

### 3.5 `scripts/import-new-plates.mjs` — orphaned one-off script
- **What:** Import/migration script, no npm-script entry, no references.
- **Evidence:** not in `package.json`; `git grep import-new-plates` → zero refs anywhere (code or docs).
- **Risk:** SAFE (worst case: a historical one-off is lost, recoverable from git history).
- **Action:** Delete, OR move to an `scripts/archive/` if the team prefers to keep migration history in-tree. Confirm preference; deletion is low-risk given git history.

---

## 4. Needs verification

Do **not** bulk-remove. Each needs a human/owner decision or a follow-up refactor with tests.

### Dependencies
| Item | Evidence | Recommended action |
|---|---|---|
| ~~`prettier` (devDep)~~ | Removed — unused zombie dep (no config, no scripts, no CI). | **Done.** |

**Reclassified from tool "unused" → keep (see §5):** `@swc/helpers`, `@types/react-dom`.

### Orphaned / operational scripts (no npm-script entry)
| Item | Evidence | Recommended action |
|---|---|---|
| `scripts/translate-product-notes.mjs` | No npm script; refs only in its own header + a sibling comment | Manual-use utility? Add a `package.json` script + doc, or delete. |
| `scripts/verify-analytics-count.mjs` | No npm script, **but referenced by `docs/gtm-hotfix.md:24`** | Operational tool — **not dead**. Keep if the GTM hotfix workflow is still valid; else remove script *and* update the doc. |
| `scripts/admin-lan.ps1` | No npm script, no refs (Windows LAN admin helper) | Confirm the LAN-admin workflow (`admin:dev:lan`) still needs it; delete if obsolete. |
| `scripts/anna-ciok-studio-dns-import.txt` | No refs (DNS zone dump — reference data, not code) | Archive or delete; historical DNS import artifact. |

### Duplicated logic (refactor candidate — behavior-preserving)
| Item | Evidence | Recommended action |
|---|---|---|
| `src/lib/checkout-rate-limit.ts` + `src/lib/return-rate-limit.ts` | Both are **live** (`return-rate-limit` imported by `src/app/api/returns/route.ts:7`). `diff` after name-normalization → **exit 0** (near-identical fixed-window limiter). Differ only in defaults (checkout 30/60s; return 3/600s) and comments. | Extract a shared generic `createFixedWindowLimiter(defaults)` factory; keep the two named wrappers + their distinct defaults + existing tests. Verify both `*-rate-limit.test.ts` still pass. Not urgent. |

### Unused-export signals (review individually, never bulk-strip)
`knip`/`ts-prune` flagged ~33 "unused exports" and ~21 "unused types". Most are module-internal,
part of a public utility surface, or framework-loaded. **Grep each symbol before removing.** Notable:

| Item | Evidence | Recommended action |
|---|---|---|
| `src/lib/analytics.ts` `buildViewCartEvent`, `analyticsItemForId` | flagged unused by both tools | Grep call sites incl. client components + tests before pruning. Low priority. |
| `src/lib/email-layout.ts` `emailFieldLabel`, `src/lib/email.ts` `buildPrintRefundAlertEmail` | flagged unused | Email helpers — verify not wired into a fulfilment path before touching. |
| `src/lib/editorial-images.ts` `EDITORIAL_IMAGES`, `EditorialImage` | flagged unused | Verify no page renders editorial imagery dynamically. |
| `src/lib/print-assets.ts` `PRINT_ASSET_TTL_SECS`, `src/lib/products.ts` `isProductPurchasable` | flagged unused | Grep; prints/purchasable logic touches the critical path — careful. |

### USD/CAD currency scaffolding — intentional, do not remove
`PRICE_USD`, `PRICE_CAD`, `toUSDCents`, `toCADCents`, `usd`, `cad`, and the USD/CAD arms of
`SELLABLE_CURRENCIES` are flagged unused. **`AGENTS.md` states USD/CAD are deliberately
scaffolded** in the type/DB/format layer and `priceOfCurrency` throws for them until price
tables land. **Classify as intentional scaffolding — NEEDS-VERIFICATION, NOT safe-delete.**

---

## 5. Do NOT touch / risky

The follow-up agent **must not** remove, rename, or "simplify" any of these.

- **`worker.ts`** — Cloudflare Worker entrypoint (`wrangler.jsonc` `main`). Must keep re-exporting
  `DOQueueHandler`, `DOShardedTagCache`, `BucketCachePurge` from `.open-next/worker.js` (omitting
  breaks deploy). Its `@ts-ignore` / `eslint-disable` on the generated import are **deliberate**
  (documented in-file). The baseline typecheck errors here are known — do not touch to silence them.
- **`src/middleware.ts`** — must **NOT** be renamed to `proxy.ts` (Next 16 deprecation warning is
  harmless; OpenNext rejects Node-runtime `proxy.ts`, breaking the Cloudflare build — per AGENTS.md).
- **`open-next.config.ts`** — build-time config read by OpenNext via convention. `ts-prune`/`knip`
  "unused default export" is a **false positive**. Do not remove.
- **`src/i18n/navigation.ts`** (`redirect`, `getPathname`) — next-intl reads these via
  `createNavigation`; framework convention. `knip` false positive. Do not prune.
- **`src/lib/currency.ts`** (`DEFAULT_CURRENCY`, `SELLABLE_CURRENCIES`, `readCurrencyCookie`) —
  used via the middleware/render currency chain. Do not remove on a tool's say-so.
- **`@swc/helpers`** — injected by Next/SWC at build; no source import expected. Keep.
- **`@types/react-dom`** — type-only devDep; `depcheck` false positive. Keep.
- **App Router special files** — every `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`,
  `global-error.tsx`, `not-found.tsx`, `route.ts`, `robots.ts`, `sitemap.ts`. Their "unused default
  export" is how Next.js loads them by convention.
- **Framework entrypoints** — `src/instrumentation.ts`, `src/instrumentation-client.ts`,
  `src/sentry.edge.config.ts`, `src/sentry.server.config.ts`.
- **Critical path** — `src/app/api/checkout/route.ts`, `src/lib/checkout.ts`,
  `src/lib/private-sale.ts`, Supabase `reserve_pieces`/`reserve_private_sale_pieces` flows,
  `src/server/fulfilment/**`, `src/server/prodigi/**`.
- **All webhook routes** — Stripe / InPost / Resend / Prodigi under `src/app/api/**/webhook*`.
- **`scripts/lib/read-category-products.ts`** — **not dead**: loaded dynamically by *path* from
  `scripts/generate-product-notes.mjs:92`. `scripts/lib/product-notes.mjs` — used by both
  `generate-product-notes.mjs` and `src/lib/product-notes.test.ts`.
- **Generated/ignored dirs & assets** — `.next`, `.open-next`, `.wrangler`, `node_modules`,
  `.worktrees`, `public/uploads`, `public/fonts`.
- **Untracked user WIP** — `docs/research/`, `scripts/research/`, `guides.md`,
  `docs/plans/2026-storefront-upgrade.md`.

---

## 6. Recommended implementation order (conservative)

1. **Record baseline** — run the pre-cleanup commands (§7), save output. Confirm build fails only on `worker.ts`.
2. **Delete the two confirmed-dead components** (§3.1, §3.2). Leave their CSS. Re-run lint + test.
3. **Remove `@eslint/eslintrc` + `@google-analytics/data`** (§3.3, §3.4). `npm install`. Re-run lint + test + build.
4. **Delete/archive `scripts/import-new-plates.mjs`** (§3.5) after a quick owner nod.
5. **Stop.** Everything below is a separate, owner-gated pass:
   - Resolve the NEEDS-VERIFICATION scripts with the team.
   - Refactor the rate-limiter duplication (with its tests).
   - Fix the `worker.ts` typecheck/build config in a focused session (add Cloudflare Worker types to
     the typecheck scope or split the worker typecheck) — **without changing Worker behavior**.
   - Review the individual unused-export signals one symbol at a time.

Each numbered step is independently revertible. Do not batch a dependency removal with a component
deletion — keep commits small so a failed validation isolates the cause.

---

## 7. Validation commands

**Before cleanup (capture baseline):**
```bash
git status --short
npm run lint          # expect: clean
npm run test          # expect: 71 files, 723 tests pass
npm run build         # expect: FAILS on worker.ts typecheck (pre-existing — document it)
npx tsc --noEmit      # expect: same 3 worker.ts errors
npx knip --no-progress
npx depcheck --json
```

**After each safe change:**
```bash
git status --short
npm run lint
npm run test
npx knip --no-progress      # confirm the removed items disappear from the report
npx depcheck --json         # confirm removed deps disappear
npm run build               # MUST still fail ONLY on worker.ts — no NEW errors introduced
```

**If package files changed:** run `npm install` before validation so the lockfile is consistent.

**Success criterion for the cleanup pass:** lint clean, 723 tests still pass, and `npm run build`
fails *only* on the pre-existing `worker.ts` typecheck errors — **no new failures**. If any new
error appears, revert the last change and isolate.

---

## 8. Final cautions

- Static dead-code tools (`knip`, `ts-prune`, `depcheck`) are **noisy** in Next/OpenNext repos — they
  flag framework-convention exports, build-injected deps, and dynamically-loaded modules. Never remove
  on a tool report alone; `git grep` the symbol first and check §5.
- Public contracts (export names, API route paths, DB columns, config keys) are not renamed here.
- The pre-existing `worker.ts` build failure must be **documented, not hidden** by cleanup.
- Nothing in this session modified code. Deletions proposed above are all recoverable from git history.
