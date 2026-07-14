# Prodigi v4 Contract Smoke — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a manually-triggered GitHub workflow that proves the Prodigi v4 contract round-trips through the real `buildProdigiPayload()` → `prodigiClient.postOrder()` → `getOrder` → `getOrderActions` → `mapProdigiStage` → `cancelOrder` against the Prodigi sandbox, self-cleaning and sandbox-only.

**Architecture:** A pure, dependency-injected orchestrator (`runProdigiContractSmoke`) in `src/server/prodigi/` drives the lifecycle and asserts each response field the fulfilment path reads, always cancelling in `finally`. A thin `tsx` runner (mirroring `scripts/print-asset-smoke.ts`) resolves one usable print asset, builds the payload through the real mapper, and calls the orchestrator with the real client. A `workflow_dispatch` workflow (mirroring `.github/workflows/post-deploy-smoke.yml`) runs it on demand against sandbox.

**Tech Stack:** TypeScript, Vitest, tsx, GitHub Actions, Supabase (script-side via `loadSupabaseClient`), existing Prodigi client (`src/server/prodigi/client.ts`).

**Spec:** `docs/superpowers/specs/2026-07-13-prodigi-contract-smoke-design.md`

## Global Constraints

- **Sandbox only, always.** The runner hard-sets `PRODIGI_ENV: 'sandbox'`; it never reads `PRODIGI_ENV` from env files. The client env object carries only the sandbox key. Live keys are never loaded. (Mirrors `scripts/prodigi-cli.ts:424-428`.)
- **Cancel every created order.** The orchestrator cancels in `finally`; the unit test proves it fires on every path.
- **No production DB mutation.** Callback coverage is `mapProdigiStage(realStage) !== null` only — the smoke never writes to `webhook_events` / `prodigi_orders` / `fulfilment_jobs`.
- **No new dependencies.** Live HTTP via the existing client + `tsx` (both already in use).
- **No changes to `src/server/prodigi/client.ts`.** `postOrder`, `getOrder`, `getOrderActions`, `cancelOrder` already exist.
- **Build stays `next build --webpack`** (project-wide rule; this plan doesn't touch the build, but no change here may imply otherwise).
- **Commits:** this repo's policy is "commit only when the user asks." The commit steps below are proposed checkpoints — stage and commit only on explicit user signal.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/server/prodigi/contract-smoke.ts` | Pure orchestrator `runProdigiContractSmoke(deps)` + result types. Injected client; cancels in `finally`. |
| `src/server/prodigi/contract-smoke.test.ts` | Vitest: fake client returning good + drift-shaped responses; asserts each drift fails loudly and cancel always fires. |
| `scripts/prodigi-contract-smoke.ts` | Thin runner: env load + sandbox guard, resolve one usable asset, mint signed URL, build payload via real mapper, call orchestrator with real client, print JSON report. |
| `.github/workflows/prodigi-contract-smoke.yml` | `workflow_dispatch` job mirroring `post-deploy-smoke.yml`; sandbox key + Supabase + asset-token secrets. |
| `package.json` | One script entry: `prodigi:contract-smoke`. |
| `docs/prodigi-contract-smoke.md` | Runbook: how to run, what a failure means, secret rotation. |
| `AGENTS.md` | One-line command entry in the Operational scripts paragraph. |

---

### Task 1: Contract-smoke orchestrator (TDD)

**Files:**
- Create: `src/server/prodigi/contract-smoke.ts`
- Test: `src/server/prodigi/contract-smoke.test.ts`

**Interfaces:**
- Consumes: `ProdigiOrderRequest`, `ProdigiOrderResponse`, `ProdigiOrderActionsResponse`, `ProdigiCancelResponse` from `./types`.
- Produces: `runProdigiContractSmoke(deps: ContractSmokeDeps): Promise<SmokeResult>` where `ContractSmokeDeps = { client: ContractClient; payload: ProdigiOrderRequest; mapStage: (stage: string) => string | null }`. `SmokeResult = { ok: boolean; prodigiOrderId?: string; steps: SmokeStep[]; cancelled: boolean }`. Task 2's runner consumes these.

- [ ] **Step 1: Write the failing test**

Create `src/server/prodigi/contract-smoke.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runProdigiContractSmoke, type ContractClient, type ContractSmokeDeps } from './contract-smoke';
import type { ProdigiOrderRequest } from './types';

const PAYLOAD: ProdigiOrderRequest = {
  shippingMethod: 'Budget',
  idempotencyKey: 'test-key',
  recipient: {
    name: 'Test',
    address: { line1: '1 Test St', postalOrZipCode: '00-001', countryCode: 'PL', townOrCity: 'Warsaw' },
  },
  items: [{ sku: 'GLOBAL-FAP-12X16', copies: 1, sizing: 'fillPrintArea', assets: [{ printArea: 'default', url: 'https://example.invalid/a.jpg' }] }],
};

type FakeOverrides = Partial<{
  created: { order?: { id?: string; status?: { stage?: string }; items?: Array<{ id?: string; sku?: string }> }; outcome?: string };
  gotStage: string;
  cancelAvailable: string;
  cancelOutcome: string;
  throwIn?: 'postOrder' | 'getOrder' | 'getOrderActions' | 'cancelOrder';
}>;

function buildDeps(overrides: FakeOverrides = {}): { deps: ContractSmokeDeps; client: ContractClient & { cancelOrder: ReturnType<typeof vi.fn> } } {
  const o = {
    created: overrides.created ?? {
      outcome: 'Created',
      order: { id: 'ord_1', status: { stage: 'InProgress' }, items: [{ id: 'item_1', sku: 'GLOBAL-FAP-12X16' }] },
    },
    gotStage: overrides.gotStage ?? 'InProgress',
    cancelAvailable: overrides.cancelAvailable ?? 'Yes',
    cancelOutcome: overrides.cancelOutcome ?? 'Cancelled',
    throwIn: overrides.throwIn,
  };
  const client = {
    postOrder: vi.fn(async () => {
      if (o.throwIn === 'postOrder') throw new Error('boom postOrder');
      return o.created as never;
    }),
    getOrder: vi.fn(async () => {
      if (o.throwIn === 'getOrder') throw new Error('boom getOrder');
      return { order: { id: 'ord_1', status: { stage: o.gotStage } } } as never;
    }),
    getOrderActions: vi.fn(async () => {
      if (o.throwIn === 'getOrderActions') throw new Error('boom actions');
      return { outcome: 'OK', cancel: { isAvailable: o.cancelAvailable } } as never;
    }),
    cancelOrder: vi.fn(async () => {
      if (o.throwIn === 'cancelOrder') throw new Error('boom cancel');
      return { outcome: o.cancelOutcome } as never;
    }),
  };
  const mapStage = vi.fn((stage: string) => (stage === 'InProgress' || stage === 'InProduction' || stage === 'Complete' || stage === 'Cancelled' ? 'ok' : null));
  return { deps: { client, payload: PAYLOAD, mapStage }, client: client as never };
}

describe('runProdigiContractSmoke', () => {
  it('passes on a well-shaped lifecycle and cancels the order', async () => {
    const { deps, client } = buildDeps();
    const res = await runProdigiContractSmoke(deps);
    expect(res.ok).toBe(true);
    expect(res.prodigiOrderId).toBe('ord_1');
    expect(res.cancelled).toBe(true);
    expect(client.cancelOrder).toHaveBeenCalledWith('ord_1');
    expect(res.steps.every((s) => s.ok)).toBe(true);
  });

  it('fails loudly and skips cancel when postOrder returns no order.id', async () => {
    const { deps, client } = buildDeps({ created: { outcome: 'Created', order: { status: { stage: 'InProgress' } } } });
    const res = await runProdigiContractSmoke(deps);
    expect(res.ok).toBe(false);
    expect(res.prodigiOrderId).toBeUndefined();
    expect(res.cancelled).toBe(false);
    expect(client.cancelOrder).not.toHaveBeenCalled();
    const createFail = res.steps.find((s) => s.step === 'create:id' && !s.ok);
    expect(createFail).toBeTruthy();
  });

  it('fails on an unrecognised status.stage but still cancels (order was created)', async () => {
    const { deps, client } = buildDeps({ gotStage: 'SomeNewStage' });
    const res = await runProdigiContractSmoke(deps);
    expect(res.ok).toBe(false);
    expect(res.cancelled).toBe(true);
    expect(client.cancelOrder).toHaveBeenCalledWith('ord_1');
    const mapFail = res.steps.find((s) => s.step === 'mapStage' && !s.ok);
    expect(mapFail).toBeTruthy();
  });

  it('fails when cancel.isAvailable is not Yes', async () => {
    const { deps } = buildDeps({ cancelAvailable: 'No' });
    const res = await runProdigiContractSmoke(deps);
    expect(res.ok).toBe(false);
    const actFail = res.steps.find((s) => s.step === 'actions:cancel' && !s.ok);
    expect(actFail).toBeTruthy();
  });

  it('accepts cancel outcome case-insensitively', async () => {
    const { deps } = buildDeps({ cancelOutcome: 'cancelled' });
    const res = await runProdigiContractSmoke(deps);
    const cancelStep = res.steps.find((s) => s.step === 'cancel');
    expect(cancelStep?.ok).toBe(true);
  });

  it('cancels even when a lifecycle step throws', async () => {
    const { deps, client } = buildDeps({ throwIn: 'getOrder' });
    const res = await runProdigiContractSmoke(deps);
    expect(res.ok).toBe(false);
    expect(res.cancelled).toBe(true);
    expect(client.cancelOrder).toHaveBeenCalledWith('ord_1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/prodigi/contract-smoke.test.ts`
Expected: FAIL — `runProdigiContractSmoke` / `ContractClient` not exported (module not found).

- [ ] **Step 3: Write the implementation**

Create `src/server/prodigi/contract-smoke.ts`:

```ts
import type {
  ProdigiCancelResponse,
  ProdigiOrderActionsResponse,
  ProdigiOrderRequest,
  ProdigiOrderResponse,
} from './types';

/** Structural subset of the prodigiClient the orchestrator needs. */
export interface ContractClient {
  postOrder: (payload: ProdigiOrderRequest) => Promise<ProdigiOrderResponse>;
  getOrder: (id: string) => Promise<{ order: ProdigiOrderResponse['order'] }>;
  getOrderActions: (id: string) => Promise<ProdigiOrderActionsResponse>;
  cancelOrder: (id: string) => Promise<ProdigiCancelResponse>;
}

export interface ContractSmokeDeps {
  client: ContractClient;
  payload: ProdigiOrderRequest;
  /** mapProdigiStage injected so the orchestrator is unit-testable without status-map. */
  mapStage: (stage: string) => string | null;
}

export type SmokeStep = { step: string; ok: true } | { step: string; ok: false; reason: string };

export interface SmokeResult {
  ok: boolean;
  prodigiOrderId?: string;
  steps: SmokeStep[];
  cancelled: boolean;
}

/**
 * Drive a real Prodigi sandbox lifecycle through the injected client and assert
 * every response field the fulfilment path (processJob / handleProdigiCallback)
 * actually reads. This is the H-1 contract check: Prodigi accepts our payload and
 * we accept Prodigi's response. **Always cancels in `finally`** so a sandbox
 * order is never left behind, even when an assertion fails.
 */
export async function runProdigiContractSmoke(deps: ContractSmokeDeps): Promise<SmokeResult> {
  const { client, payload, mapStage } = deps;
  const steps: SmokeStep[] = [];
  let prodigiOrderId: string | undefined;
  let cancelled = false;
  let realStage: string | undefined;

  try {
    const created = await client.postOrder(payload);
    prodigiOrderId = created.order?.id;
    steps.push(
      created.outcome
        ? { step: 'create:outcome', ok: true }
        : { step: 'create:outcome', ok: false, reason: 'postOrder response missing outcome' },
    );
    steps.push(
      prodigiOrderId && typeof prodigiOrderId === 'string'
        ? { step: 'create:id', ok: true }
        : { step: 'create:id', ok: false, reason: `postOrder response missing order.id: ${JSON.stringify(created)}` },
    );
    const stage0 = created.order?.status?.stage;
    steps.push(
      typeof stage0 === 'string'
        ? { step: 'create:stage', ok: true }
        : { step: 'create:stage', ok: false, reason: 'postOrder response missing order.status.stage' },
    );
    const item0 = created.order?.items?.[0];
    steps.push(
      item0?.id && item0?.sku
        ? { step: 'create:items', ok: true }
        : { step: 'create:items', ok: false, reason: 'postOrder response missing order.items[0].id/sku' },
    );

    if (prodigiOrderId) {
      const got = await client.getOrder(prodigiOrderId);
      steps.push(
        got.order?.id === prodigiOrderId
          ? { step: 'getOrder:id', ok: true }
          : { step: 'getOrder:id', ok: false, reason: `getOrder order.id mismatch (got ${got.order?.id}, expected ${prodigiOrderId})` },
      );
      realStage = got.order?.status?.stage;
      steps.push(
        typeof realStage === 'string'
          ? { step: 'getOrder:stage', ok: true }
          : { step: 'getOrder:stage', ok: false, reason: 'getOrder response missing order.status.stage' },
      );

      const actions = await client.getOrderActions(prodigiOrderId);
      steps.push(
        actions.cancel?.isAvailable === 'Yes'
          ? { step: 'actions:cancel', ok: true }
          : { step: 'actions:cancel', ok: false, reason: `cancel.isAvailable='${actions.cancel?.isAvailable ?? 'missing'}' (expected 'Yes')` },
      );

      if (typeof realStage === 'string') {
        const mapped = mapStage(realStage);
        steps.push(
          mapped !== null
            ? { step: 'mapStage', ok: true }
            : { step: 'mapStage', ok: false, reason: `mapProdigiStage('${realStage}') returned null — unrecognised stage (schema drift)` },
        );
      }
    }
  } catch (e) {
    steps.push({ step: 'lifecycle', ok: false, reason: e instanceof Error ? e.message : String(e) });
  } finally {
    if (prodigiOrderId) {
      try {
        const cancel = await client.cancelOrder(prodigiOrderId);
        cancelled = true;
        const outcome = String(cancel.outcome ?? '').toLowerCase();
        steps.push(
          outcome === 'cancelled'
            ? { step: 'cancel', ok: true }
            : { step: 'cancel', ok: false, reason: `cancel outcome='${cancel.outcome}' (expected 'Cancelled', case-insensitive)` },
        );
      } catch (e) {
        // Order was created but cancel failed — surface it; do NOT mask other failures.
        steps.push({ step: 'cancel', ok: false, reason: `cancel threw: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  return { ok: steps.length > 0 && steps.every((s) => s.ok), prodigiOrderId, steps, cancelled };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/prodigi/contract-smoke.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit (proposed checkpoint)**

```bash
git add src/server/prodigi/contract-smoke.ts src/server/prodigi/contract-smoke.test.ts
git commit -m "feat(prodigi): add contract-smoke orchestrator (H-1)"
```

---

### Task 2: Runner script + package.json entry

**Files:**
- Create: `scripts/prodigi-contract-smoke.ts`
- Modify: `package.json` (scripts block)

**Interfaces:**
- Consumes: `runProdigiContractSmoke`, `ContractSmokeDeps` from Task 1; `prodigiClient` from `src/server/prodigi/client`; `buildProdigiPayload`, `OrderRow`, `PrintItemRow` from `src/server/prodigi/mapper`; `mapProdigiStage` from `src/server/fulfilment/status-map`; `PRODIGI_SKU_MAP`, `parseVariantKey` from `src/lib/print-cart`; `signPrintAssetUrl` from `src/lib/print-assets`; `getWorkerOrigin` from `src/lib/site.server`; `loadLocalEnv`, `loadSupabaseClient` from `./lib/script-env`.
- Produces: a runnable `npm run prodigi:contract-smoke` that exits non-zero on contract failure.

- [ ] **Step 1: Write the runner**

Create `scripts/prodigi-contract-smoke.ts`:

```ts
/**
 * Prodigi v4 contract smoke (audit H-1). Drives a real sandbox lifecycle
 * (create → getOrder → actions → mapProdigiStage → cancel) through the production
 * mapper + client, proving the contract round-trips. Sandbox-only, self-cleaning.
 *
 *   npm run prodigi:contract-smoke -- [--product fap01] [--strict] [--json] [--env-file PATH]
 *
 * Requires PRODIGI_API_KEY_SANDBOX + PRINT_ASSET_TOKEN_SECRET + SUPABASE_*.
 * --strict: fail (exit 1) when no usable print asset exists; without it, that case
 *           is an exit-0 skip (pre-launch, mirroring print-asset:smoke).
 * --json:   emit only the JSON report.
 */
import { signPrintAssetUrl } from '../src/lib/print-assets';
import { PRODIGI_SKU_MAP, parseVariantKey } from '../src/lib/print-cart';
import { getWorkerOrigin } from '../src/lib/site.server';
import { mapProdigiStage } from '../src/server/fulfilment/status-map';
import { prodigiClient } from '../src/server/prodigi/client';
import { runProdigiContractSmoke } from '../src/server/prodigi/contract-smoke';
import { buildProdigiPayload, type OrderRow, type PrintItemRow } from '../src/server/prodigi/mapper';
import { loadLocalEnv, loadSupabaseClient } from './lib/script-env';

type ReadyAssetFull = {
  id: string;
  r2_key: string;
  sha256: string;
  content_type: 'image/jpeg' | 'image/png';
  width_px: number;
  height_px: number;
  profile_key: string;
  revision: string;
};

function parseArgs(): { product: string; strict: boolean; json: boolean } {
  const argv = process.argv.slice(2);
  let product = 'fap01';
  let strict = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--product') product = argv[++i] ?? product;
    else if (argv[i] === '--strict') strict = true;
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: npm run prodigi:contract-smoke -- [--product fap01] [--strict] [--json] [--env-file PATH]');
      process.exit(0);
    }
  }
  return { product, strict, json };
}

/** UTC date + minute — unique per run, folded into idempotencyKey + merchantReference. */
function runId(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 16).replace(':', '')}`;
}

/**
 * Resolve one ready asset whose pixel dimensions match a known PRODIGI_SKU_MAP
 * variant — guarantees buildProdigiPayload's assertSnapshotDimensions passes.
 * Script-side query (getSupabaseAdmin is Workers-only; mirrors print-asset-smoke).
 */
async function resolveUsableAsset(
  product: string,
): Promise<{ variantKey: string; asset: ReadyAssetFull } | null> {
  const supabase = loadSupabaseClient();
  const { data, error } = await supabase
    .from('print_fulfilment_assets')
    .select('id, r2_key, sha256, content_type, width_px, height_px, profile_key, revision')
    .eq('product_id', product)
    .eq('status', 'ready')
    .order('verified_at', { ascending: false })
    .order('sha256', { ascending: false });
  if (error) throw new Error(`asset lookup failed: ${error.message}`);
  for (const row of (data ?? []) as ReadyAssetFull[]) {
    const variantKey = Object.keys(PRODIGI_SKU_MAP).find((vk) => {
      const px = PRODIGI_SKU_MAP[vk]!.printAreaPx;
      return px.w === row.width_px && px.h === row.height_px;
    });
    if (variantKey) return { variantKey, asset: row };
  }
  return null;
}

async function main(): Promise<void> {
  const { product, strict, json } = parseArgs();
  const env = loadLocalEnv();
  const apiKey = env.PRODIGI_API_KEY_SANDBOX;
  const secret = env.PRINT_ASSET_TOKEN_SECRET;
  if (!apiKey) throw new Error('PRODIGI_API_KEY_SANDBOX required (.dev.vars / --env-file / process env)');
  if (!secret) throw new Error('PRINT_ASSET_TOKEN_SECRET required (.dev.vars / --env-file / process env)');

  const origin = getWorkerOrigin({ WORKER_ORIGIN: env.WORKER_ORIGIN }).replace(/\/$/, '');

  const resolved = await resolveUsableAsset(product);
  if (!resolved) {
    const reason = `no ready print_fulfilment_assets row with a matching variant on ${product}`;
    if (strict) throw new Error(reason);
    const skip = { skipped: true, reason };
    console.log(json ? JSON.stringify(skip, null, 2) : `skipped: ${reason}`);
    return;
  }
  const { variantKey, asset } = resolved;
  const sel = parseVariantKey(variantKey);
  const skuMap = PRODIGI_SKU_MAP[variantKey]!;
  const signedUrl = await signPrintAssetUrl(asset.id, secret, Date.now(), origin);

  const order: OrderRow = {
    id: `contract-smoke-${runId()}`,
    currency: 'pln',
    email: 'contract-smoke@example.invalid',
    receiver_first_name: 'Contract',
    receiver_last_name: 'Smoke',
    receiver_phone: '+48111111111',
    shipping_address: {
      street: '1 Test Street',
      building_number: '1',
      city: 'Warsaw',
      post_code: '00-001',
      country_code: 'PL',
    },
    delivery_method: 'kurier',
  };

  const items: PrintItemRow[] = [
    {
      product_id: product,
      unit_price: 10000, // 100.00 PLN — major-unit formatted by the mapper; value irrelevant to the contract
      variant: {
        prodigiSku: skuMap.sku,
        framed: sel.framed,
        mount: sel.mount,
        frameColour: sel.frameColour,
        printAreaPx: skuMap.printAreaPx,
        assetId: asset.id,
        assetKey: asset.r2_key,
        assetSha256: asset.sha256,
        assetContentType: asset.content_type,
        assetWidthPx: asset.width_px,
        assetHeightPx: asset.height_px,
      },
    },
  ];
  const assetUrls: Record<string, string> = { [asset.id]: signedUrl };

  // Mapper env: sandbox so idempotencyKey/baseUrl resolve to sandbox values.
  // callbackUrl uses a clearly-non-real token when the prod token isn't present
  // (CI): cancelled sandbox orders don't deliver callbacks, and the shape — not
  // the token — is what the contract asserts.
  const mapperEnv = {
    PRODIGI_ENV: 'sandbox',
    PRODIGI_DEFAULT_SHIPPING_METHOD: env.PRODIGI_DEFAULT_SHIPPING_METHOD ?? 'Budget',
    PRODIGI_CALLBACK_TOKEN: env.PRODIGI_CALLBACK_TOKEN ?? 'contract-smoke-no-callback',
    WORKER_ORIGIN: origin,
  } as unknown as CloudflareEnv;

  const payload = buildProdigiPayload(order, items, assetUrls, mapperEnv);

  // Client env: sandbox only, sandbox key only. baseUrl() resolves to the sandbox
  // host regardless of the key value, so a misconfigured key fails closed (401)
  // and can never create a live order.
  const clientEnv = {
    PRODIGI_ENV: 'sandbox',
    PRODIGI_API_KEY_SANDBOX: apiKey,
    PRODIGI_API_KEY_LIVE: '',
  } as unknown as CloudflareEnv;

  const result = await runProdigiContractSmoke({
    client: prodigiClient(clientEnv),
    payload,
    mapStage: mapProdigiStage,
  });

  const report = {
    product,
    variantKey,
    sku: skuMap.sku,
    assetId: asset.id,
    ...result,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add the package.json script**

In `package.json`, in the `"scripts"` block, next to the existing `"prodigi": "tsx scripts/prodigi-cli.ts",` line, add:

```json
    "prodigi:contract-smoke": "tsx scripts/prodigi-contract-smoke.ts",
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors (the runner imports resolve cleanly; `CloudflareEnv` is a project global).

- [ ] **Step 4: Verify the runner parses and the guard is reachable**

Run: `npm run prodigi:contract-smoke -- --help`
Expected: prints the usage line and exits 0 (proves the script is wired and tsx parses it).

The sandbox-only / missing-secret guard is a code-read (`if (!apiKey) throw …` before any network call). If you want to exercise it live, run in a checkout with no `.dev.vars`/`.env.local` Prodigi secrets and no `PRODIGI_API_KEY_SANDBOX` in your shell:
`npm run prodigi:contract-smoke -- --json`
Expected: exits 1 with `Error: PRODIGI_API_KEY_SANDBOX required ...`. (Skip this if your working copy has `.dev.vars` with the sandbox key — `loadLocalEnv` reads `.dev.vars` regardless of `--env-file`, so the guard won't fire there; that's fine, the guard is verified by reading the code.)

- [ ] **Step 5: Commit (proposed checkpoint)**

```bash
git add scripts/prodigi-contract-smoke.ts package.json
git commit -m "feat(prodigi): add contract-smoke runner (H-1)"
```

---

### Task 3: workflow_dispatch workflow

**Files:**
- Create: `.github/workflows/prodigi-contract-smoke.yml`

**Interfaces:**
- Consumes: the `npm run prodigi:contract-smoke` script from Task 2; repo secrets `PRODIGI_API_KEY_SANDBOX`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PRINT_ASSET_TOKEN_SECRET`; repo variable `PRODIGI_SMOKE_STRICT` (optional).
- Produces: a manually-triggered, sandbox-only contract smoke that goes red on schema drift.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/prodigi-contract-smoke.yml`:

```yaml
name: prodigi-contract-smoke

# Audit H-1: prove the Prodigi v4 contract round-trips through the real
# mapper + client against the SANDBOX. Manually triggered (workflow_dispatch)
# only — never per-PR, never scheduled. Sandbox-only, self-cleaning (the runner
# cancels every order it creates). Fails red on schema drift.
#
# ⚠️ Requires the repo secret PRODIGI_API_KEY_SANDBOX (a second copy of the
# sandbox key, alongside SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
# PRINT_ASSET_TOKEN_SECRET already used by post-deploy-smoke). Keep this on the
# default branch and never point it at a live key.
on:
  workflow_dispatch:
    branches: [main]

permissions:
  contents: read

jobs:
  prodigi-contract-smoke:
    name: Prodigi v4 sandbox contract smoke
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          ref: ${{ github.event.repository.default_branch }}
          persist-credentials: false

      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: '22'
          cache: npm

      - name: Install (locked)
        run: npm ci

      - name: Contract smoke (sandbox create → inspect → cancel)
        # Pre-launch (PRODIGI_SMOKE_STRICT unset/false): a missing usable asset
        # is an exit-0 skip. Set PRODIGI_SMOKE_STRICT=true once a print asset is
        # published so a missing asset fails.
        run: |
          if [ "${{ vars.PRODIGI_SMOKE_STRICT }}" = "true" ]; then
            npm run prodigi:contract-smoke -- --json --strict
          else
            npm run prodigi:contract-smoke -- --json
          fi
        env:
          PRODIGI_API_KEY_SANDBOX: ${{ secrets.PRODIGI_API_KEY_SANDBOX }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          PRINT_ASSET_TOKEN_SECRET: ${{ secrets.PRINT_ASSET_TOKEN_SECRET }}
          WORKER_ORIGIN: https://anna-ciok.studio
```

- [ ] **Step 2: Lint the YAML locally (optional sanity)**

Run: `npx --no-install actionlint .github/workflows/prodigi-contract-smoke.yml 2>/dev/null || node -e "require('fs').readFileSync('.github/workflows/prodigi-contract-smoke.yml','utf8')" && echo "yaml present"`
Expected: prints `yaml present` (actionlint may not be installed; the fallback confirms the file is readable; YAML validity is enforced by GitHub on dispatch).

- [ ] **Step 3: Commit (proposed checkpoint)**

```bash
git add .github/workflows/prodigi-contract-smoke.yml
git commit -m "ci(prodigi): add workflow_dispatch contract smoke (H-1)"
```

---

### Task 4: Runbook + AGENTS.md command entry

**Files:**
- Create: `docs/prodigi-contract-smoke.md`
- Modify: `AGENTS.md` (Operational scripts paragraph)

**Interfaces:**
- Consumes: nothing code-level.
- Produces: operator documentation for the new smoke.

- [ ] **Step 1: Write the runbook**

Create `docs/prodigi-contract-smoke.md`:

````markdown
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
````

- [ ] **Step 2: Add the AGENTS.md command entry**

In `AGENTS.md`, in the Operational scripts paragraph (the long `npm run prodigi (Prodigi API v4 CLI …)` sentence), insert a reference to the new smoke immediately after the `npm run prodigi` clause. Locate:

```
`npm run prodigi` (Prodigi API v4 CLI — sandbox quotes/orders, SKU lookup, order inspection; see `docs/prodigi-cli.md`),
```

Replace with:

```
`npm run prodigi` (Prodigi API v4 CLI — sandbox quotes/orders, SKU lookup, order inspection; see `docs/prodigi-cli.md`), `npm run prodigi:contract-smoke` (manual sandbox create→inspect→cancel contract smoke proving the real mapper+client round-trip — audit H-1; runs locally or via the `prodigi-contract-smoke` workflow_dispatch; see `docs/prodigi-contract-smoke.md`),
```

- [ ] **Step 3: Commit (proposed checkpoint)**

```bash
git add docs/prodigi-contract-smoke.md AGENTS.md
git commit -m "docs(prodigi): contract-smoke runbook + AGENTS command (H-1)"
```

---

## Final verification (after Task 4)

- [ ] `npm run typecheck` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm run test` — green (existing suite + the new `contract-smoke.test.ts`).
- [ ] `npm run prodigi:contract-smoke -- --help` — prints usage, exits 0.
- [ ] (Operator, when ready) trigger the workflow on `main` after adding the `PRODIGI_API_KEY_SANDBOX` secret; confirm a green create→cancel against sandbox.

## Notes for the implementer

- The orchestrator is deliberately pure (injected client + `mapStage`) so the unit test proves the **assertions** and the **cancel-guarantee** without a live API. The *contract* itself is validated only by the live workflow — do not mistake the unit test for H-1's closure; the workflow run is the proof.
- If `resolveUsableAsset` returns null in CI pre-launch, the run skips green (unless `PRODIGI_SMOKE_STRICT=true`). That is expected, not a failure.
- The runner does not reuse `resolvePrintAsset` (Workers-only via `getSupabaseAdmin`); it mirrors `print-asset-smoke`'s inline `loadSupabaseClient()` query instead. This is the one deviation from the spec's "reuse the resolver" wording — called out here and in the runbook's scope section.
