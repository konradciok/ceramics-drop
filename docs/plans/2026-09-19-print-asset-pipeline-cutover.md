# Print-Asset Pipeline Cutover (Priority 8 / Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the CMS-driven print-asset pipeline (Tasks 8-12, already live — upload → job → Container-rendered derivatives, staged in `print_fulfilment_assets`) the two missing steps that make it actually usable end to end: promoting a completed job's derivatives from `staged` to `ready`, and publishing a `ready` revision so it's assigned to the product's live variants — closing the gap `assets-mapping.ts` and `profiles.ts` already document by name.

**Architecture:** Two small, independently-testable additions on the ceramics-drop side (an auto-promotion step folded into the existing job finalize, and a new `POST /v1/jobs/{id}/publish` CmsApi handler wrapping the already-existing `publish_print_asset_revision` RPC), plus one new regression test proving the Container's Sharp entry point and the CLI's Sharp entry point produce byte-identical output for the same source (they already share the same underlying `derivatives.ts` module — this guards against the two thin wrappers ever silently diverging). cms-ceramics gets the corresponding mock support and a "Publish" button on completed jobs. The CLI (`print-assets-{prepare,upload,verify,publish}.ts`) is untouched and stays the manual/bulk/outage-fallback path — nothing here retires it.

**Tech Stack:** TypeScript, Supabase (Postgres RPCs), Cloudflare Workers, Vitest, Playwright, React Query, openapi-typescript.

**Spec:** `docs/plans/print-asset-pipeline.md` (original CLI pipeline design) and the "Priority 8 — Uploads/Assets/Jobs pipeline" section of `cms-ceramics/docs/plans/2026-09-17-CMS-Reliability-Completeness` (Phases 0-3, already merged via PR #318; this plan is Phase 4). This plan's tasks were derived by reading the current, already-merged state of `src/server/asset-jobs/*`, `src/server/cms-api/handlers/*`, `src/server/print-assets/*`, and `contracts/cms-v1.json` directly — not from a separate written spec for Phase 4 (the original plan explicitly deferred Phase 4's concrete design to "decisions made during 0-2").

## Global Constraints

- Service-role only: every new DB call goes through `ctx.supabase` (CmsApi handlers) or `supabaseFromEnv(env)` (queue consumer) — never a new client, never RLS-bypassing code outside those two entry points.
- Idempotency: every new mutating CmsApi endpoint requires an `Idempotency-Key` header and uses `claimIdempotencyKey`/`releaseIdempotencyKey`/`completeIdempotencyKey` from `src/server/cms-api/idempotency.ts`, exactly like `jobs-retry.ts`.
- CAS discipline: every mutating endpoint's body carries `expectedRevision` (the job's `PrintAssetJobRow.attempts`-derived contract `revision`, same idiom as retry), checked before any write.
- Sharp/Workers boundary: `promote.ts`, `publish-assignments.ts`, and `jobs-publish.ts` must NEVER import `sharp`, `derivatives.ts`, or anything under `scripts/`. Only `container-handler.ts`/`container/server.ts` and the CLI may touch Sharp.
- Multi-ratio products are explicitly out of scope. `profiles.ts`'s own header comment already documents this: a CMS-driven revision is per-upload (`cms-${uploadId}`), but `publish_print_asset_revision` requires ONE revision to cover every active variant of a product. A product whose active variants span more than one print ratio cannot be published from a single CMS upload yet. Do not attempt to solve this here — let the RPC's `assignment_mismatch` surface as a clear, operator-actionable error, per the existing design.
- `contracts/cms-v1.json` is duplicated in both repos (`ceramics-drop/contracts/cms-v1.json` and `cms-ceramics/contracts/cms-v1.json`) and must be edited identically in both. After editing cms-ceramics's copy, regenerate its TypeScript types with `npm run contract:generate` (writes `src/lib/api/schema.d.ts`).
- `CONTRACT_VERSION` (`cms-ceramics/src/lib/server/gateway.ts`) does not need bumping for this plan — a new route (`POST /v1/jobs/{id}/publish`) is purely additive, not a breaking change to an existing route or field's shape.
- The CLI (`npm run print-assets:{prepare,upload,verify,publish}`) is NOT retired or modified by this plan. It stays the manual/bulk/outage-fallback path, per the original plan's explicit instruction.

---

### Task 1: Prove the Container and CLI Sharp entry points are byte-identical

**Files:**
- Create: `src/server/print-assets/entrypoint-parity.test.ts`

**Interfaces:**
- Consumes: `renderFullBleedDerivative` from `./container-handler` (existing, unchanged), `composeFullBleedDerivative` from `scripts/lib/prepare-derivatives` (existing, unchanged), `MAX_SOURCE_BYTES`/`MAX_SOURCE_PIXELS`/`DerivativeSpec` from `../asset-jobs/container-protocol` (existing, unchanged).
- Produces: nothing new consumed by later tasks — this is a standalone regression guard.

Both `renderFullBleedDerivative` (the Container's entry point, buffer-based) and `composeFullBleedDerivative` (the CLI's entry point, file-based) already call the same underlying `composeFullBleedDerivative` in `src/server/print-assets/derivatives.ts` internally — so this test isn't proving the Sharp math is correct (that's already covered elsewhere); it's a regression guard that fails loudly if either thin wrapper is ever changed to call something else, silently breaking the guarantee the whole cutover depends on.

- [ ] **Step 1: Write the failing test**

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { MAX_SOURCE_BYTES, MAX_SOURCE_PIXELS, type DerivativeSpec } from '../asset-jobs/container-protocol';
import { renderFullBleedDerivative } from './container-handler';
import { composeFullBleedDerivative } from '../../scripts/lib/prepare-derivatives';

// Regression guard for the print-asset pipeline cutover (Priority 8 / Phase 4):
// the CmsApi/Container path (renderFullBleedDerivative, buffer-based) and the
// CLI path (composeFullBleedDerivative, file-based) both wrap the SAME shared
// composeFullBleedDerivative in ./derivatives — this test proves that stays
// true by comparing their actual output, not their source code. If someone
// ever changes one wrapper to call something else, this is what catches it.

let scratchDir: string;
let master3x4Path: string;
let master3x4Buffer: Buffer;

beforeAll(async () => {
  master3x4Buffer = await sharp({
    create: { width: 300, height: 400, channels: 3, background: '#2244aa' },
  })
    .jpeg()
    .toBuffer();
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-parity-'));
  master3x4Path = path.join(scratchDir, 'master-3x4.jpg');
  fs.writeFileSync(master3x4Path, master3x4Buffer);
});

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe('Container vs CLI Sharp entry points', () => {
  it('produce byte-identical derivatives for the same source, target, and format', async () => {
    const spec: DerivativeSpec = {
      jobId: 'parity-test',
      uploadId: 'parity-test',
      sourceContentType: 'image/jpeg',
      expectedRatio: '3x4',
      target: { w: 60, h: 80 },
      format: 'jpg',
      maxSourceBytes: MAX_SOURCE_BYTES,
      maxSourcePixels: MAX_SOURCE_PIXELS,
    };

    const containerResult = await renderFullBleedDerivative(spec, master3x4Buffer);
    const cliResult = await composeFullBleedDerivative({
      sourcePath: master3x4Path,
      target: spec.target,
      format: spec.format,
    });

    expect(containerResult.sha256).toBe(cliResult.sha256);
    expect(containerResult.byteSize).toBe(cliResult.byteSize);
    expect(containerResult.buffer.equals(cliResult.buffer)).toBe(true);
  });

  it('still produce byte-identical output for a different target and a png source', async () => {
    const pngBuffer = await sharp({
      create: { width: 300, height: 450, channels: 3, background: '#aa4422' },
    })
      .png()
      .toBuffer();
    const pngPath = path.join(scratchDir, 'master-2x3.png');
    fs.writeFileSync(pngPath, pngBuffer);

    const spec: DerivativeSpec = {
      jobId: 'parity-test-2',
      uploadId: 'parity-test-2',
      sourceContentType: 'image/png',
      expectedRatio: '2x3',
      target: { w: 100, h: 150 },
      format: 'png',
      maxSourceBytes: MAX_SOURCE_BYTES,
      maxSourcePixels: MAX_SOURCE_PIXELS,
    };

    const containerResult = await renderFullBleedDerivative(spec, pngBuffer);
    const cliResult = await composeFullBleedDerivative({
      sourcePath: pngPath,
      target: spec.target,
      format: spec.format,
    });

    expect(containerResult.sha256).toBe(cliResult.sha256);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/print-assets/entrypoint-parity.test.ts`
Expected: FAIL — either a module-not-found error (if any import path above doesn't match the real file, fix the import) or the test file doesn't exist yet on a fresh checkout. Since both underlying functions already exist and already share `derivatives.ts`, the test is actually expected to PASS once the imports are correct — there's no new implementation code here. If it fails for a reason OTHER than "file doesn't exist yet," that's a real finding: it means the two wrappers have already diverged, and this task should stop and report it rather than silently proceeding.

- [ ] **Step 3: Confirm it passes (no implementation needed — this is a pure regression test)**

Run: `npx vitest run src/server/print-assets/entrypoint-parity.test.ts`
Expected: PASS (2/2). If it fails, the two Sharp wrappers have genuinely diverged — stop and investigate `container-handler.ts` and `scripts/lib/prepare-derivatives.ts` before continuing to any later task in this plan.

- [ ] **Step 4: Commit**

```bash
git add src/server/print-assets/entrypoint-parity.test.ts
git commit -m "test(print-assets): prove Container and CLI Sharp entry points stay byte-identical"
```

---

### Task 2: Auto-promote a job's staged assets to ready on successful finalize

**Files:**
- Create: `src/server/asset-jobs/promote.ts`
- Test: `src/server/asset-jobs/promote.test.ts`
- Modify: `src/server/asset-jobs/process-job.ts:369-382` (between staging and the missing-keys check)
- Modify: `src/server/asset-jobs/process-job.test.ts` (new assertions)

**Interfaces:**
- Produces: `promoteStagedAssets(supabase: SupabaseClient, input: { productId: string; revision: string; r2Keys: string[] }): Promise<{ promoted: { r2Key: string; promoted: boolean }[] }>` — consumed by `process-job.ts` in this task, and conceptually mirrors what `print-assets:verify` does today via `promoteVerifiedAssets`, but for the CMS pipeline (no local manifest — the render that just staged these rows IS the verification, since it ran server-side in the same trusted request, unlike the CLI's separate "verify a possibly-different machine's upload" step).

Why this is safe to do unconditionally (not gated behind a manual review step per job): `promote_print_assets_ready` only flips rows that are still `staged` under the exact `(product_id, revision, r2_key)` triple this job itself just wrote in the SAME function invocation — there is no separate "upload from an untrusted machine" step in this pipeline the way there is for the CLI, so the trust boundary the CLI's `verify` step protects against doesn't exist here. Task 1's regression test is the one-time confidence check that the render math itself is correct; this task is what makes that confidence actually useful.

- [ ] **Step 1: Write the failing test for `promoteStagedAssets`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { promoteStagedAssets } from './promote';

function makeChain(returnValue: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.rpc = vi.fn(async () => returnValue);
  return chain;
}

describe('promoteStagedAssets', () => {
  it('calls promote_print_assets_ready with the product, revision, and r2Keys, and returns the promotion results', async () => {
    const rpcResult = {
      data: [
        { r2_key: 'prints/p1/cms-u1/60x80-aaa.jpg', promoted: true },
        { r2_key: 'prints/p1/cms-u1/100x150-bbb.jpg', promoted: false },
      ],
      error: null,
    };
    const rpc = vi.fn(async (name: string, args: unknown) => {
      expect(name).toBe('promote_print_assets_ready');
      expect(args).toMatchObject({
        p_product_id: 'p1',
        p_revision: 'cms-u1',
        p_r2_keys: ['prints/p1/cms-u1/60x80-aaa.jpg', 'prints/p1/cms-u1/100x150-bbb.jpg'],
      });
      return rpcResult;
    });
    const supabase = { rpc } as never;

    const result = await promoteStagedAssets(supabase, {
      productId: 'p1',
      revision: 'cms-u1',
      r2Keys: ['prints/p1/cms-u1/60x80-aaa.jpg', 'prints/p1/cms-u1/100x150-bbb.jpg'],
    });

    expect(result.promoted).toEqual([
      { r2Key: 'prints/p1/cms-u1/60x80-aaa.jpg', promoted: true },
      { r2Key: 'prints/p1/cms-u1/100x150-bbb.jpg', promoted: false },
    ]);
  });

  it('throws when the RPC errors', async () => {
    const supabase = { rpc: vi.fn(async () => ({ data: null, error: new Error('promotion_state_changed') })) } as never;
    await expect(
      promoteStagedAssets(supabase, { productId: 'p1', revision: 'cms-u1', r2Keys: ['k1'] }),
    ).rejects.toThrow('promotion_state_changed');
  });

  it('is a no-op for an empty r2Keys list (never calls the RPC)', async () => {
    const rpc = vi.fn();
    const supabase = { rpc } as never;
    const result = await promoteStagedAssets(supabase, { productId: 'p1', revision: 'cms-u1', r2Keys: [] });
    expect(result.promoted).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/asset-jobs/promote.test.ts`
Expected: FAIL with "Cannot find module './promote'" (the file doesn't exist yet).

- [ ] **Step 3: Write `promote.ts`**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Promote a set of `staged` print_fulfilment_assets rows to `ready`, via the
 * `promote_print_assets_ready` RPC (supabase/migrations/20260721120000_promote_print_assets_ready.sql).
 *
 * Used by process-job.ts right after a job successfully stages its
 * derivatives (Priority 8 / Phase 4). Unlike the CLI's print-assets:verify —
 * which re-downloads R2 objects and hashes them against a local manifest,
 * because a CLI upload could come from any machine — this promotion trusts
 * the rows it was JUST asked to promote, because they were staged by the same
 * trusted server-side render this function is called from. There is no
 * separate untrusted-transport step to re-verify here.
 *
 * Never throws for "nothing to promote" (empty r2Keys) — throws only on a
 * genuine RPC error (transient DB fault, or a concurrent revoke racing this
 * call and raising `promotion_state_changed`), which the caller (a queue
 * consumer) should treat as retryable, same as every other DB error in that
 * path.
 */
export async function promoteStagedAssets(
  supabase: SupabaseClient,
  input: { productId: string; revision: string; r2Keys: string[] },
): Promise<{ promoted: { r2Key: string; promoted: boolean }[] }> {
  if (input.r2Keys.length === 0) return { promoted: [] };

  const { data, error } = await supabase.rpc('promote_print_assets_ready', {
    p_product_id: input.productId,
    p_revision: input.revision,
    p_r2_keys: input.r2Keys,
  });
  if (error) throw error;

  const rows = (data ?? []) as { r2_key: string; promoted: boolean }[];
  return { promoted: rows.map((r) => ({ r2Key: r.r2_key, promoted: r.promoted })) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/asset-jobs/promote.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Wire promotion into `process-job.ts`'s finalize sequence**

In `src/server/asset-jobs/process-job.ts`, add the import at the top (alongside the existing `./profiles` import):

```typescript
import { promoteStagedAssets } from './promote';
```

Then, between the existing "missing keys" check and the "// 8. Finalize" comment (i.e., right after `byKey`/`missingKeys` are computed and confirmed non-empty, and before the job is marked `completed`), insert:

```typescript
  // 7b. Promote every just-staged row to ready (Priority 8 / Phase 4) — see
  // promote.ts's header comment for why this is safe to do unconditionally
  // here, unlike the CLI's separate verify step. A promotion failure is
  // always a transient DB fault or a genuine concurrent-revoke race; treat it
  // the same as any other DB error in this function: retryable.
  const revision = assetRevisionForUpload(uploadId);
  await promoteStagedAssets(supabase, { productId: uploadRow.product_id, revision, r2Keys: keys });
```

(`assetRevisionForUpload` is already imported from `./profiles` at the top of this file — no new import needed for it.)

- [ ] **Step 6: Add the corresponding assertion to `process-job.test.ts`**

Find the existing test that exercises a full successful job run (the one asserting the job ends up `status: 'completed'` with `asset_id` set — read the file to find its exact name and the shape of its Supabase mock chain before writing this addition, since the mock's `rpc` method needs a handler for `promote_print_assets_ready` added alongside whatever it already returns for other calls). Add an assertion that `supabase.rpc` was called with `'promote_print_assets_ready'` and the job's staged `r2_key`s, e.g.:

```typescript
  it('promotes every staged asset to ready as part of a successful finalize', async () => {
    const rpcCalls: Array<{ name: string; args: unknown }> = [];
    const supabase = makeSuccessfulJobSupabaseMock({
      onRpc: (name, args) => rpcCalls.push({ name, args }),
    });
    await processAssetJob({ jobId: 'job-1', uploadId: 'upload-1' }, { ...baseEnv, supabase } as never, {} as never);

    const promoteCall = rpcCalls.find((c) => c.name === 'promote_print_assets_ready');
    expect(promoteCall).toBeDefined();
    expect(promoteCall?.args).toMatchObject({ p_product_id: 'product-1', p_revision: 'cms-upload-1' });
  });
```

(`makeSuccessfulJobSupabaseMock` and `baseEnv` are placeholders for whatever this test file's existing successful-run helper and fixture are actually named — read the file first and use its real names; the point of this step is the assertion shape, not this exact helper name.)

- [ ] **Step 7: Run the full asset-jobs test suite**

Run: `npx vitest run src/server/asset-jobs/`
Expected: all tests PASS, including the new ones.

- [ ] **Step 8: Commit**

```bash
git add src/server/asset-jobs/promote.ts src/server/asset-jobs/promote.test.ts src/server/asset-jobs/process-job.ts src/server/asset-jobs/process-job.test.ts
git commit -m "feat(asset-jobs): auto-promote a job's staged assets to ready on finalize"
```

---

### Task 3: Pure publish-assignment builder

**Files:**
- Create: `src/server/asset-jobs/publish-assignments.ts`
- Test: `src/server/asset-jobs/publish-assignments.test.ts`

**Interfaces:**
- Consumes: `VariantDimension`, `DerivativeProfile`, `distinctProfiles` from `@/lib/print-assets-prepare` (existing, unchanged).
- Produces: `buildJobPublishAssignments(variants: VariantDimension[], readyAssetIdByProfileKey: Map<string, string>): PublishAssignmentResult` — consumed by Task 4's handler.

This mirrors `src/lib/print-assets-publish.ts`'s `buildPublishAssignments`, but sourced from the DB's active-variant rows (already loaded by `loadActivePrintVariants` in `profiles.ts`) and the DB's own `print_fulfilment_assets.profile_key` column, instead of a local CLI manifest — there is no manifest in the CMS-driven flow, only the DB itself. (`profile_key` is a real, queryable column — `e.g. '3600x4800'`, see `supabase/migrations/20260711120000_print_fulfilment_assets.sql` — so there's no need to reconstruct a content-addressed r2_key, which would require the derivative's sha256 that this handler never independently computes.)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { buildJobPublishAssignments } from './publish-assignments';
import type { VariantDimension } from '@/lib/print-assets-prepare';

describe('buildJobPublishAssignments', () => {
  it('maps every active variant to its profile asset id when all are ready', () => {
    const variants: VariantDimension[] = [
      { variantKey: 'small:false:false:none', w: 60, h: 80 },
      { variantKey: 'medium:false:false:none', w: 60, h: 80 },
      { variantKey: 'large:false:false:none', w: 100, h: 150 },
    ];
    const readyAssetIdByProfileKey = new Map([
      ['60x80', 'asset-1'],
      ['100x150', 'asset-2'],
    ]);
    const result = buildJobPublishAssignments(variants, readyAssetIdByProfileKey);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.assignments).toEqual(
      expect.arrayContaining([
        { variant_key: 'small:false:false:none', asset_id: 'asset-1' },
        { variant_key: 'medium:false:false:none', asset_id: 'asset-1' },
        { variant_key: 'large:false:false:none', asset_id: 'asset-2' },
      ]),
    );
    expect(result.assignments).toHaveLength(3);
  });

  it('reports missing profiles instead of throwing, when a variant has no ready asset yet', () => {
    const variants: VariantDimension[] = [
      { variantKey: 'small:false:false:none', w: 60, h: 80 },
      { variantKey: 'large:false:false:none', w: 100, h: 150 },
    ];
    // Only the 60x80 profile has a ready asset — 100x150 is missing, e.g.
    // because it belongs to a different ratio this upload never covered
    // (the documented multi-ratio-product limitation).
    const readyAssetIdByProfileKey = new Map([['60x80', 'asset-1']]);
    const result = buildJobPublishAssignments(variants, readyAssetIdByProfileKey);

    expect(result.kind).toBe('missing_profiles');
    if (result.kind !== 'missing_profiles') throw new Error('expected missing_profiles');
    expect(result.missingVariantKeys).toEqual(['large:false:false:none']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/asset-jobs/publish-assignments.test.ts`
Expected: FAIL with "Cannot find module './publish-assignments'".

- [ ] **Step 3: Write `publish-assignments.ts`**

```typescript
import { distinctProfiles, type VariantDimension } from '@/lib/print-assets-prepare';

export interface PublishAssignment {
  variant_key: string;
  asset_id: string;
}

export type PublishAssignmentResult =
  | { kind: 'ok'; assignments: PublishAssignment[] }
  | { kind: 'missing_profiles'; missingVariantKeys: string[] };

/**
 * Build the (variant_key, asset_id) pairs `publish_print_asset_revision`
 * needs, for every ACTIVE variant of a product — not just the ratio one
 * upload covered. `readyAssetIdByProfileKey` is keyed by
 * print_fulfilment_assets.profile_key ("60x80") — a real, directly queryable
 * column (see supabase/migrations/20260711120000_print_fulfilment_assets.sql),
 * not reconstructed from the content-addressed r2_key (which would need the
 * derivative's sha256, something this caller never independently computes).
 *
 * Fails closed (kind: 'missing_profiles') rather than throwing when a
 * variant's profile has no ready row yet — this is the expected, documented
 * shape of the multi-ratio-product limitation (profiles.ts's own header
 * comment): a single CMS upload only ever stages ONE ratio's profiles, so a
 * product spanning multiple ratios will always be missing some variants here
 * until every ratio has its own upload under the same revision. The caller
 * turns this into a clear operator-facing error instead of an opaque RPC
 * failure.
 */
export function buildJobPublishAssignments(
  variants: VariantDimension[],
  readyAssetIdByProfileKey: Map<string, string>,
): PublishAssignmentResult {
  const profiles = distinctProfiles(variants);
  const assignments: PublishAssignment[] = [];
  const missingVariantKeys: string[] = [];

  for (const profile of profiles) {
    const assetId = readyAssetIdByProfileKey.get(profile.profileKey);
    if (!assetId) {
      missingVariantKeys.push(...profile.variantKeys);
      continue;
    }
    for (const variantKey of profile.variantKeys) {
      assignments.push({ variant_key: variantKey, asset_id: assetId });
    }
  }

  if (missingVariantKeys.length > 0) {
    return { kind: 'missing_profiles', missingVariantKeys: missingVariantKeys.sort() };
  }
  return { kind: 'ok', assignments };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/asset-jobs/publish-assignments.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/server/asset-jobs/publish-assignments.ts src/server/asset-jobs/publish-assignments.test.ts
git commit -m "feat(asset-jobs): add a pure publish-assignment builder for CMS-driven revisions"
```

---

### Task 4: `POST /v1/jobs/{id}/publish` handler + contract + route registration

**Files:**
- Create: `src/server/cms-api/handlers/jobs-publish.ts`
- Test: `src/server/cms-api/handlers/jobs-publish.test.ts`
- Modify: `src/server/cms-api/request-handler.ts` (register the route)
- Modify: `contracts/cms-v1.json` (add the path)

**Interfaces:**
- Consumes: `getJobRowById` (from `../jobs-mapping`), `getUploadRowById` (from `../uploads-mapping`), `loadActivePrintVariants`, `assetRevisionForUpload` (from `@/server/asset-jobs/profiles`), `buildJobPublishAssignments` (Task 3), `claimIdempotencyKey`/`releaseIdempotencyKey`/`completeIdempotencyKey` (from `../idempotency`), `jsonResponse`/`errorResponse` (from `../http`) — all existing, unchanged.
- Produces: the `jobsPublishRoute: RouteDef` consumed by `request-handler.ts` in this task.

- [ ] **Step 1: Write the failing test**

Read `src/server/cms-api/handlers/jobs-retry.test.ts` first — this handler follows the exact same shape (UUID guard, Idempotency-Key requirement, `expectedRevision` CAS, idempotency claim/release/complete), so its test file's mock-building helpers are your template. Then write:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { jobsPublishRoute } from './jobs-publish';

function req(body: unknown, headers: Record<string, string> = { 'Idempotency-Key': 'k1' }): Request {
  return new Request('http://x/v1/jobs/11111111-1111-1111-1111-111111111111/publish', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /v1/jobs/{id}/publish', () => {
  it('rejects a non-uuid job id with 404', async () => {
    const res = await jobsPublishRoute.handler(
      req({ expectedRevision: 1 }),
      {} as never,
      { id: 'not-a-uuid' },
      { supabase: {} as never, requestId: 'r1' } as never,
    );
    expect(res.status).toBe(404);
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await jobsPublishRoute.handler(
      req({ expectedRevision: 1 }, {}),
      {} as never,
      { id: '11111111-1111-1111-1111-111111111111' },
      { supabase: {} as never, requestId: 'r1' } as never,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('requires expectedRevision as an integer', async () => {
    const res = await jobsPublishRoute.handler(
      req({}),
      {} as never,
      { id: '11111111-1111-1111-1111-111111111111' },
      { supabase: {} as never, requestId: 'r1' } as never,
    );
    expect(res.status).toBe(422);
  });

  it('publishes a completed job whose product has full ready coverage', async () => {
    const rpcCalls: Array<{ name: string; args: unknown }> = [];
    const supabase = {
      rpc: vi.fn(async (name: string, args: unknown) => {
        rpcCalls.push({ name, args });
        if (name === 'publish_print_asset_revision') {
          return { data: [{ product_id: 'p1', revision: 'cms-u1', assigned_count: 1 }], error: null };
        }
        return { data: null, error: null };
      }),
      from: vi.fn((table: string) => {
        if (table === 'print_asset_jobs') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: '11111111-1111-1111-1111-111111111111', upload_id: 'u1', status: 'completed', attempts: 1, asset_revision: 1 },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'print_asset_uploads') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { id: 'u1', product_id: 'p1' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'products') {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: { status: 'active' }, error: null }) }),
            }),
          };
        }
        if (table === 'product_variants') {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({
                  data: [{ variant_key: 'small:false:false:none', print_area_width_px: 60, print_area_height_px: 80 }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'print_fulfilment_assets') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: async () => ({ data: [{ id: 'asset-1', profile_key: '60x80' }], error: null }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    } as never;

    const res = await jobsPublishRoute.handler(
      req({ expectedRevision: 1 }),
      {} as never,
      { id: '11111111-1111-1111-1111-111111111111' },
      { supabase, requestId: 'r1' } as never,
    );

    expect(res.status).toBe(200);
    const publishCall = rpcCalls.find((c) => c.name === 'publish_print_asset_revision');
    expect(publishCall).toBeDefined();
  });
});
```

(This test's mock is intentionally minimal/illustrative — once you read the real shapes of `getJobRowById`/`getUploadRowById`/`loadActivePrintVariants` and how `jobs-retry.test.ts` mocks `ctx.supabase`'s query-builder chain for similar reads, adjust the mock's chain shape to match exactly what your implementation in Step 3 actually calls. The assertions — 404 for bad id, 422 for missing header/body field, 200 with a `publish_print_asset_revision` RPC call on the happy path — are what must hold regardless.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/cms-api/handlers/jobs-publish.test.ts`
Expected: FAIL with "Cannot find module './jobs-publish'".

- [ ] **Step 3: Write `jobs-publish.ts`**

```typescript
import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { getJobRowById } from '../jobs-mapping';
import { getUploadRowById } from '../uploads-mapping';
import { loadActivePrintVariants, assetRevisionForUpload } from '@/server/asset-jobs/profiles';
import { buildJobPublishAssignments } from '@/server/asset-jobs/publish-assignments';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../idempotency';

// print_asset_jobs.id is a uuid column — same guard as jobs-retry.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /v1/jobs/{id}/publish — Priority 8 / Phase 4. Assigns a completed
 * job's ready print_fulfilment_assets to every active variant of its product,
 * via the existing publish_print_asset_revision RPC — the same "go live"
 * action the CLI's print-assets:publish performs, exposed through CmsApi for
 * the CMS-driven pipeline.
 *
 * Scope note (see publish-assignments.ts and this plan's Global Constraints):
 * a job's revision only covers the ONE ratio its upload was for. A product
 * whose active variants span more than one ratio will always be missing some
 * variants here — reported as 422 MISSING_PROFILES, not silently partial.
 */
export const jobsPublishRoute: RouteDef = {
  method: 'POST',
  path: '/v1/jobs/{id}/publish',
  handler: async (req, env, params, ctx) => {
    if (!UUID_RE.test(params.id)) {
      return errorResponse('NOT_FOUND', `Job ${params.id} does not exist.`, 404, ctx.requestId);
    }

    const idempotencyKey = req.headers.get('Idempotency-Key');
    if (!idempotencyKey) {
      return errorResponse('IDEMPOTENCY_REQUIRED', 'Idempotency-Key header is required.', 422, ctx.requestId);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('VALIDATION_FAILED', 'Request body must be valid JSON.', 422, ctx.requestId);
    }
    if (typeof body !== 'object' || body === null) {
      return errorResponse('VALIDATION_FAILED', 'Request body must be a JSON object.', 422, ctx.requestId);
    }
    const parsed = body as { expectedRevision?: unknown };
    if (!Number.isInteger(parsed.expectedRevision)) {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision is required.', 422, ctx.requestId, {
        fieldErrors: { expectedRevision: 'required' },
      });
    }

    const claim = await claimIdempotencyKey(ctx.supabase, 'jobs:publish', idempotencyKey, { id: params.id, ...parsed });
    if (claim.kind === 'replay') return jsonResponse(claim.body, claim.status);
    if (claim.kind === 'in_progress') {
      return errorResponse('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress.', 409, ctx.requestId);
    }
    if (claim.kind === 'key_reuse') {
      return errorResponse('IDEMPOTENCY_KEY_REUSE', 'This Idempotency-Key was already used with a different request body.', 422, ctx.requestId);
    }
    const { leaseToken } = claim;
    const release = async () => {
      try {
        await releaseIdempotencyKey(ctx.supabase, 'jobs:publish', idempotencyKey, leaseToken);
      } catch {
        // ignore — see uploads-confirm.ts's identical rationale.
      }
    };

    const job = await getJobRowById(ctx.supabase, params.id);
    if (!job) {
      await release();
      return errorResponse('NOT_FOUND', `Job ${params.id} does not exist.`, 404, ctx.requestId);
    }
    // Same CAS convention as jobs-retry.ts: Job.revision (the contract field)
    // is row.asset_revision — the upload's revision snapshot, NOT row.attempts.
    if (job.asset_revision !== parsed.expectedRevision) {
      await release();
      return errorResponse(
        'REVISION_CONFLICT',
        'To zadanie zmieniło stan od czasu ostatniego odczytu.',
        409,
        ctx.requestId,
        { currentRevision: job.asset_revision },
      );
    }
    if (job.status !== 'completed') {
      await release();
      return errorResponse('VALIDATION_FAILED', `Job ${params.id} is not completed (status="${job.status}").`, 422, ctx.requestId);
    }

    const upload = await getUploadRowById(ctx.supabase, job.upload_id);
    if (!upload) {
      await release();
      return errorResponse('NOT_FOUND', `Upload ${job.upload_id} for this job no longer exists.`, 404, ctx.requestId);
    }

    const variantsResult = await loadActivePrintVariants(ctx.supabase, upload.product_id);
    if (variantsResult.kind === 'invalid') {
      await release();
      return errorResponse('VALIDATION_FAILED', variantsResult.message, 422, ctx.requestId);
    }

    // print_fulfilment_assets.profile_key is a real, directly queryable
    // column (e.g. "3600x4800") — no need to reconstruct the content-
    // addressed r2_key, which would require a sha256 this handler never
    // independently computes. See publish-assignments.ts's header comment.
    const revision = assetRevisionForUpload(job.upload_id);
    const { data: readyRows, error: readyErr } = await ctx.supabase
      .from('print_fulfilment_assets')
      .select('id, profile_key')
      .eq('product_id', upload.product_id)
      .eq('revision', revision)
      .eq('status', 'ready');
    if (readyErr) {
      await release();
      return errorResponse('INTERNAL_ERROR', 'Failed to read ready assets.', 500, ctx.requestId);
    }
    const readyAssetIdByProfileKey = new Map(
      ((readyRows ?? []) as { id: string; profile_key: string | null }[])
        .filter((r): r is { id: string; profile_key: string } => r.profile_key !== null)
        .map((r) => [r.profile_key, r.id]),
    );

    const assignmentResult = buildJobPublishAssignments(variantsResult.variants, readyAssetIdByProfileKey);
    if (assignmentResult.kind === 'missing_profiles') {
      await release();
      return errorResponse(
        'MISSING_PROFILES',
        `Not every active variant has a ready asset under revision "${revision}" — missing: ${assignmentResult.missingVariantKeys.join(', ')}. ` +
          'This product may span more than one print ratio; see this plan\'s Global Constraints.',
        422,
        ctx.requestId,
      );
    }

    try {
      const { data, error } = await ctx.supabase.rpc('publish_print_asset_revision', {
        p_product_id: upload.product_id,
        p_revision: revision,
        p_assignments: assignmentResult.assignments,
      });
      if (error) throw error;
      const row = (data as { product_id: string; revision: string; assigned_count: number }[] | null)?.[0];
      const result = { productId: upload.product_id, revision, assignedCount: row?.assigned_count ?? 0 };
      // Argument order matches jobs-retry.ts's completeIdempotencyKey call:
      // (supabase, scope, idempotencyKey, leaseToken, status, body) — status
      // BEFORE body.
      await completeIdempotencyKey(ctx.supabase, 'jobs:publish', idempotencyKey, leaseToken, 200, result);
      return jsonResponse(result, 200);
    } catch (e) {
      await release();
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('assignment_mismatch')) {
        return errorResponse('MISSING_PROFILES', `Publish assignment does not exactly match active variants: ${message}`, 422, ctx.requestId);
      }
      return errorResponse('INTERNAL_ERROR', `Publish failed: ${message}`, 500, ctx.requestId);
    }
  },
};
```

Note on `profileKeyFromPx`/`derivativeR2Key`: read `src/lib/print-assets-prepare.ts`'s exact signatures for both before finalizing this step — the call above assumes `derivativeR2Key(manifestLike, derivativeLike)` accepts objects shaped like `{productId, revision}` and `{width, height, sha256, byteSize, format}` respectively (matching how `process-job.ts` and the CLI already call it elsewhere in this codebase), but confirm the exact field names against the real function signature and adjust if they differ.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/cms-api/handlers/jobs-publish.test.ts`
Expected: PASS (4/4). Adjust the test's mock chain shapes as needed once you see what the real implementation actually calls (per Step 1's note) — the four behavioral assertions (404 / 422 missing header / 422 missing field / 200 with RPC call) must all still hold.

- [ ] **Step 5: Register the route in `request-handler.ts`**

Add the import near the other `jobs-*` imports:

```typescript
import { jobsPublishRoute } from './handlers/jobs-publish';
```

Add it to the routes array near the other `jobs*Route` entries:

```typescript
  jobsPublishRoute,
```

- [ ] **Step 6: Add the path to `contracts/cms-v1.json`**

In the `paths` object, add (matching the existing `/v1/jobs/{id}/retry` entry's shape as your template — read it first):

```json
"/v1/jobs/{id}/publish": {
  "post": {
    "operationId": "publishJob",
    "parameters": [
      { "name": "id", "in": "path", "required": true, "schema": { "type": "string" } },
      { "name": "Idempotency-Key", "in": "header", "required": true, "schema": { "type": "string" } }
    ],
    "requestBody": {
      "required": true,
      "content": {
        "application/json": {
          "schema": {
            "type": "object",
            "properties": { "expectedRevision": { "type": "integer" } },
            "required": ["expectedRevision"],
            "additionalProperties": false
          }
        }
      }
    },
    "responses": {
      "200": {
        "description": "Published.",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "productId": { "type": "string" },
                "revision": { "type": "string" },
                "assignedCount": { "type": "integer" }
              },
              "required": ["productId", "revision", "assignedCount"],
              "additionalProperties": false
            }
          }
        }
      },
      "404": { "$ref": "#/components/responses/NotFound" },
      "422": { "$ref": "#/components/responses/ValidationFailed" }
    }
  }
}
```

Check the existing `/v1/jobs/{id}/retry` entry for the exact `$ref` names this contract actually uses for its shared 404/422 response components, and match them exactly rather than assuming the names above are correct.

- [ ] **Step 7: Run the full ceramics-drop test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/cms-api/handlers/jobs-publish.ts src/server/cms-api/handlers/jobs-publish.test.ts src/server/cms-api/request-handler.ts contracts/cms-v1.json
git commit -m "feat(cms-api): add POST /v1/jobs/{id}/publish"
```

---

### Task 5: cms-ceramics — sync the contract and add mock support for publish

**Files:**
- Modify: `cms-ceramics/contracts/cms-v1.json` (same addition as ceramics-drop Task 4 Step 6, byte-for-byte)
- Modify: `cms-ceramics/src/lib/mock/store.ts`

**Interfaces:**
- Consumes: whatever `store.ts`'s existing `POST /v1/jobs/{id}/retry` mock handler does (read it first — this task's handler mirrors its shape: look up the job by id, validate `expectedRevision`, mutate state, return a response).
- Produces: nothing new consumed by later tasks in ceramics-drop; Task 6 (cms-ceramics UI) consumes this mock's behavior for its e2e test.

- [ ] **Step 1: Copy the contract addition**

Copy Task 4 Step 6's exact JSON addition into `cms-ceramics/contracts/cms-v1.json`'s `paths` object.

- [ ] **Step 2: Regenerate the TypeScript types**

Run: `npm run contract:generate`
Expected: `src/lib/api/schema.d.ts` is regenerated and now includes a `"/v1/jobs/{id}/publish"` entry. Run `npx tsc --noEmit` afterward — expect it to still pass (this task doesn't consume the new type anywhere else yet).

- [ ] **Step 3: Write the failing mock test**

Read `tests/mock.test.ts` (or wherever this repo's existing mock-store tests for job actions live — find the test for `POST /v1/jobs/{id}/retry` and use its exact setup pattern) and add:

```typescript
  it('POST /v1/jobs/{id}/publish marks a completed job as published and returns the assignment result', async () => {
    const store = createMockStore();
    // Seed a completed job the same way the existing retry test seeds a
    // failed one — read that test to match the exact seeding helper this
    // file already uses, then adapt status to 'completed'.
    const job = seedCompletedJob(store); // replace with this file's real seeding helper
    const res = await store.handle(
      new Request(`http://x/v1/jobs/${job.id}/publish`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'pub-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: job.revision }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ assignedCount: expect.any(Number) });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mock.test.ts -t publish`
Expected: FAIL — the mock store returns 404/501 for an unregistered route.

- [ ] **Step 4: Add the mock handler to `store.ts`**

Read the existing `POST /v1/jobs/{id}/retry` handler in `store.ts` in full before writing this — match its exact style (how it looks up a job, validates `expectedRevision` against the seeded job's `revision`, and returns errors) rather than inventing a new shape. Add a case for `POST /v1/jobs/{id}/publish` that: finds the job by id (404 if missing), returns 422 if the job's `status !== "completed"`, returns 422 if `expectedRevision` doesn't match, otherwise mutates the job/associated asset(s) status as appropriate for this mock's existing state model and returns `{ productId, revision, assignedCount }` (pick a small positive integer for `assignedCount` — e.g. the count of assets seeded for that job — since the mock has no real variant-matching logic to run).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/mock.test.ts -t publish`
Expected: PASS.

- [ ] **Step 6: Run the full cms-ceramics test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add contracts/cms-v1.json src/lib/api/schema.d.ts src/lib/mock/store.ts tests/mock.test.ts
git commit -m "feat(mock): support POST /v1/jobs/{id}/publish"
```

---

### Task 6: CMS UI — "Publish" action on a completed job

**Files:**
- Modify: `src/app/assets/page.tsx`
- Modify: `e2e/cms.spec.ts`

**Interfaces:**
- Consumes: the `POST /v1/jobs/{id}/publish` mock from Task 5, the existing `key()`/`Action`/`ErrorNotice` helpers already used by the retry button in this same file.

Note: once Task 2 (ceramics-drop, auto-promotion) is live, a completed job's derivatives are already `ready` and already show up in the asset grid above with `<Status value="ready" />` — no change needed there. This task only adds the explicit "go live" action, matching the CLI's `--confirm` requirement with a simple confirm gate in the UI (not a native `confirm()` dialog — this repo's own convention elsewhere in this file is an inline confirm step, not a browser dialog; follow whatever pattern `giftCard`/other irreversible-action buttons in this codebase already use, or a simple two-click "Publikuj → Na pewno?" toggle if no existing precedent applies).

- [ ] **Step 1: Write the failing e2e test**

Read the existing `e2e/cms.spec.ts` test that exercises the retry button (search for `"Ponów zadanie"`) — use its exact setup (mocked jobs list, mocked fetch responses) as your template. Add:

```typescript
test("publishes a completed job", async ({ page }) => {
  // Seed one completed job via whatever this spec file's existing
  // page.route/mock-store seeding convention is (mirror the retry test's
  // setup, with job.status = "completed" instead of "failed").
  await page.goto("/assets");
  const jobRow = page.locator("text=Rewizja").locator("..").filter({ hasText: "Ukończone" });
  await jobRow.getByRole("button", { name: "Publikuj" }).click();
  // If a confirm step exists, click through it here.
  await expect(page.getByText(/opublikowano/i)).toBeVisible();
});
```

(Exact locators depend on this file's established conventions for status labels/button text — read a neighboring test for the real Polish strings and role-query style before finalizing, per this repo's own e2e-testing convention of role/label-based queries.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test -g "publishes a completed job"`
Expected: FAIL — no "Publikuj" button exists yet.

- [ ] **Step 3: Add the Publish action to `assets/page.tsx`**

In the jobs list rendering block (where `job.status === "failed"` currently renders the "Ponów zadanie" `Action`), add an adjacent branch:

```tsx
              {job.status === "completed" && (
                <Action
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const result = unwrap(
                        await api.POST("/v1/jobs/{id}/publish", {
                          params: {
                            path: { id: job.id },
                            header: key(`${job.id}:publish`),
                          },
                          body: { expectedRevision: job.revision },
                        }),
                      );
                      setProgress(
                        `Opublikowano: przypisano ${result.assignedCount} wariant(ów).`,
                      );
                      await client.invalidateQueries({ queryKey: ["assets"] });
                      await client.invalidateQueries({ queryKey: ["jobs"] });
                    } catch (e) {
                      setError(e as Error);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Publikuj
                </Action>
              )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test -g "publishes a completed job"`
Expected: PASS.

- [ ] **Step 5: Run the full cms-ceramics test suite**

Run: `npm test && npx playwright test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/assets/page.tsx e2e/cms.spec.ts
git commit -m "feat(cms): add a Publish action for completed asset-processing jobs"
```

---

## Verification

**Per-task automated verification:** each task's own steps run the relevant suite (`npm test` in ceramics-drop for backend changes, `npm test`/`npx playwright test` in cms-ceramics for UI/mock changes) before moving to the next task.

**Manual acceptance step (required before treating this pipeline as routine, not automatable):**

1. Pick one real, single-ratio print product (a product whose active variants all resolve to the same print ratio — check via `loadActivePrintVariants`/`distinctProfiles` or simply pick a product you know has one variant size).
2. Upload its approved master image through the CMS UI's Pliki screen exactly as an operator would (this exercises Tasks 8-12's already-live pipeline plus this plan's Task 2 auto-promotion).
3. Once the job shows `status: completed`, confirm the corresponding asset now shows `status: ready` in the same screen's asset grid.
4. Click "Publikuj" (Task 6) and confirm the response reports the expected `assignedCount` (should equal the product's active variant count).
5. Separately, on the same source file, run `npm run print-assets:prepare -- --product <id> --revision cms-check-1` locally, then `npm run print-assets:verify -- --product <id> --revision cms-check-1 --dry-run`, and compare the reported SHA-256 hashes against what the CMS-driven job actually staged (visible via a direct `print_fulfilment_assets` query, or logged by the job). They should match exactly — this is the plan's one-time real-world confidence check that Task 1's synthetic-fixture parity test also holds for a real photograph, not just a generated test swatch.
6. Confirm the published variant's product page on the storefront preview actually serves the new derivative.

Only after this manual check succeeds should the CMS UI's asset flow be treated as the default/primary path for new uploads going forward — the CLI remains available as the manual/bulk/outage-fallback path per this plan's Global Constraints, not retired.
