# Proportional print-asset composition Implementation Plan

Status: Tasks 1–6 implemented on `feat/print-composition`; prepare-time
hardening and documentation completed 2026-07-17. The real-asset proof remains
operator-gated and stops before upload/publication for visual approval.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prepare-time `crop(flattened-master)` step with proportional layer composition (artwork master + background colour + SVG signature) so every Prodigi print variant preserves consistent composition proportions across aspect ratios — without touching the downstream fulfilment contract.

**Architecture:** Pure layout math + validators in `src/lib/print-assets-prepare.ts` (unit-tested, no Sharp); the Sharp compose pipeline in `scripts/lib/prepare-derivatives.ts`; a new product-level `layout` config replacing per-profile crops; an additive manifest extension. R2 keys, the atomic publish RPC, checkout snapshot, signed route, queue consumer, fail-closed paths, and `mapper.ts` are unchanged. Spec: `docs/superpowers/specs/2026-07-16-proportional-print-composition-design.md`.

**Tech Stack:** TypeScript, Vitest, Sharp (already a dependency), Node `fs`/`crypto`.

## Global Constraints

- Build must stay `next build --webpack` — never Turbopack (OpenNext/Workers).
- Sharp stays under `scripts/` — its native binding is Workers-incompatible; never `import sharp` from `src/lib/`.
- Prodigi exact-pixel contract preserved: every derivative's decoded dimensions must equal the variant's `printAreaPx` (`assertSnapshotDimensions` in `src/server/prodigi/mapper.ts`).
- Deterministic encoding carried over from the current pipeline: JPG `quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true`; PNG `compressionLevel: 9, adaptiveFiltering: false`.
- Artwork is colour-managed into sRGB and the final derivative embeds an sRGB ICC profile via `.withMetadata()`.
- Fail-closed fulfilment paths are untouched; introduce no public-image fallback.
- No new dependencies — Sharp already present.
- Conventional Commits; at least one `feat(print-assets):` commit so release-please cuts a version bump.
- Manifest field names `sourceSha256` / `sourceWidth` / `sourceHeight` are **kept** (they now refer to the artwork master). Only additive fields are introduced — this keeps `buildStagedRows`, upload, verify, publish, and gallery untouched.

## Refinement over the spec

The spec proposed renaming `sourceSha256` → `artworkSha256`. A grep confirms no manifest consumer reads those fields, but keeping the names anyway avoids even cosmetic churn across `src/lib/print-assets-publish.ts` and every Phase 2b script. The artwork master *is* the source, so the name stays accurate. `signatureSha256` and `layout` are the only additive top-level fields.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/lib/print-assets-prepare.ts` | Pure layout math, validators, config + manifest types | Modify (Tasks 1–3) |
| `src/lib/print-assets-prepare.test.ts` | Unit tests for the pure math + validators + manifest | Modify (Tasks 1–3) |
| `scripts/lib/prepare-derivatives.ts` | Sharp compose pipeline (the only Sharp-touching module) | Modify (Task 4) |
| `scripts/lib/prepare-derivatives.test.ts` | Sharp compose smoke test with generated fixtures | Create (Task 4) |
| `scripts/print-assets-prepare.ts` | Operator CLI: load config → resolve layout → compose → manifest | Modify (Task 5) |
| `config/print-assets/fap01.json` | Product layout config | Modify (Task 6) |
| `config/print-assets/README.md` | Config authoring notes | Modify (Task 6) |
| `docs/print-asset-runbook.md`, `AGENTS.md`, `docs/plans/print-asset-pipeline.md` | Docs | Modify (Task 7) |

**Untouched (do not edit):** `scripts/print-assets-upload.ts`, `scripts/print-assets-verify.ts`, `scripts/print-assets-publish.ts`, `scripts/print-assets-gallery.ts`, `src/lib/print-assets-publish.ts`, `src/lib/print-assets.ts`, `src/server/prodigi/mapper.ts`, `src/server/print-assets/*`, `src/app/api/print-assets/[id]/route.ts`, checkout, queue consumer, DB migrations.

---

### Task 1: Pure layout placement math

Resolve a proportional layout definition to concrete pixel boxes on a target canvas, including contain-scaling the artwork. No Sharp, no I/O — fully unit-testable.

**Files:**
- Modify: `src/lib/print-assets-prepare.ts` (add `PrintLayout`, `Placement`, `resolvePlacement`)
- Test: `src/lib/print-assets-prepare.test.ts` (add `describe('resolvePlacement', …)`)

**Interfaces:**
- Consumes: nothing (new foundation)
- Produces: `PrintLayout`, `Placement`, `resolvePlacement(layout, target, artwork, hasSignature): Placement` — used by Tasks 2, 3, 4, 5

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/print-assets-prepare.test.ts` (add `resolvePlacement` to the existing import from `./print-assets-prepare` once the type exists; for the failing-test step, import it now and let the run fail on the missing export):

```ts
import { resolvePlacement, type PrintLayout } from './print-assets-prepare';

const LAYOUT: PrintLayout = {
  sideMargin: 0.1,
  topMargin: 0.1,
  bottomMargin: 0.1,
  gapAboveSignature: 0.05,
  signatureZoneHeight: 0.05,
};

describe('resolvePlacement', () => {
  it('places a same-aspect artwork centred with proportional margins', () => {
    // 1000x1000 canvas, 1:1 artwork fills the box.
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 800, h: 800 }, true);
    // sideMargin 10% of short side (1000) → mx = 100 → availableW = 800
    expect(p.artworkBox.x).toBe(100);
    expect(p.artworkBox.width).toBe(800);
    // artwork 800x800 contain-fills the 800-wide box exactly
    expect(p.artworkOut).toEqual({ width: 800, height: 800 });
    expect(p.artworkPos).toEqual({ x: 100, y: 100 });
    expect(p.scale).toBe(1);
  });

  it('contain-fits a different-aspect artwork without cropping', () => {
    // Wide artwork (1600x800, 2:1) in a square box → height-limited.
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 1600, h: 800 }, true);
    // artworkBox height = 1000 - 100(top) - 50(gap) - 50(sig) - 100(bottom) = 700
    expect(p.artworkBox.height).toBe(700);
    // scale limited by height: min(800/1600, 700/800) = min(0.5, 0.875) = 0.5
    expect(p.scale).toBe(0.5);
    expect(p.artworkOut).toEqual({ width: 800, height: 400 });
  });

  it('reserves and returns the signature zone when hasSignature is true', () => {
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 800, h: 800 }, true);
    // sigZoneTop = 1000 - 100(bottom) - 50(sigZone) = 850
    expect(p.signatureBox).toEqual({ x: 100, y: 850, width: 800, height: 50 });
  });

  it('collapses the signature zone and gap when hasSignature is false', () => {
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 800, h: 800 }, false);
    expect(p.signatureBox).toBeNull();
    // artworkBox height expands into the freed gap+sig space:
    // 1000 - 100(top) - 0 - 0 - 100(bottom) = 800
    expect(p.artworkBox.height).toBe(800);
  });

  it('honours optional artworkMaxWidth / artworkMaxHeight ceilings', () => {
    const layout: PrintLayout = { ...LAYOUT, artworkMaxWidth: 0.5, artworkMaxHeight: 0.4 };
    const p = resolvePlacement(layout, { w: 1000, h: 1000 }, { w: 800, h: 800 }, false);
    // availableW = 800, but artworkMaxWidth 0.5*1000 = 500 caps it
    expect(p.artworkBox.width).toBe(500);
    // derived height 800, but artworkMaxHeight 0.4*1000 = 400 caps it
    expect(p.artworkBox.height).toBe(400);
  });

  it('uses the short side for side margins so portrait vs landscape differ correctly', () => {
    // Landscape 1000x500 canvas, sideMargin 10% of short side (500) → mx = 50
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 500 }, { w: 800, h: 200 }, false);
    expect(p.artworkBox.x).toBe(50);
    expect(p.artworkBox.width).toBe(900); // 1000 - 2*50
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/print-assets-prepare.test.ts`
Expected: FAIL — `resolvePlacement is not exported` / `PrintLayout is not exported`.

- [ ] **Step 3: Add the types and `resolvePlacement`**

Add to `src/lib/print-assets-prepare.ts`, immediately after the `DerivativeProfile` block (before the existing `// ── Crop / enlargement guards ──` section):

```ts
// ── Proportional layout (composition) ────────────────────────────────────────

/**
 * Proportional composition rules — fractions of the target canvas, resolved to
 * concrete pixels per profile by `resolvePlacement`. Replaces the per-profile
 * `crop` model (docs/superpowers/specs/2026-07-16-proportional-print-composition-design.md).
 *
 * Side margins are a fraction of the SHORT side (robust across portrait/
 * landscape); vertical regions are fractions of canvas height.
 */
export interface PrintLayout {
  sideMargin: number;          // fraction of min(W, H), applied both sides
  topMargin: number;           // fraction of H
  bottomMargin: number;        // fraction of H
  gapAboveSignature: number;   // fraction of H (ignored when no signature)
  signatureZoneHeight: number; // fraction of H (ignored when no signature)
  /** Optional ceiling on the artwork box width, fraction of W. */
  artworkMaxWidth?: number;
  /** Optional ceiling on the artwork box height, fraction of H. */
  artworkMaxHeight?: number;
}

/** A pixel rectangle on the canvas. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Resolved placement of artwork + signature on one target canvas. */
export interface Placement {
  /** The artwork contain-target box (margins/ceilings applied). */
  artworkBox: Box;
  /** The signature zone, or null when the design has no signature. */
  signatureBox: Box | null;
  /** Contain-scaled artwork output dimensions (preserve aspect). */
  artworkOut: { width: number; height: number };
  /** Top-left canvas position of the scaled artwork (centred in available width). */
  artworkPos: { x: number; y: number };
  /** Artwork contain scale = min(boxW/srcW, boxH/srcH). Used for no-upscale validation. */
  scale: number;
}

const round = Math.round;

/**
 * Resolve a proportional layout to concrete pixel boxes on a target canvas.
 * Pure + deterministic (round-half-up). See spec §Layout model for the math.
 */
export function resolvePlacement(
  layout: PrintLayout,
  target: { w: number; h: number },
  artwork: { w: number; h: number },
  hasSignature: boolean,
): Placement {
  const { w, h } = target;
  const shortSide = Math.min(w, h);

  const mx = round(layout.sideMargin * shortSide);
  const mt = round(layout.topMargin * h);
  const mb = round(layout.bottomMargin * h);
  const gap = hasSignature ? round(layout.gapAboveSignature * h) : 0;
  const sigZone = hasSignature ? round(layout.signatureZoneHeight * h) : 0;

  const availableW = w - 2 * mx;
  const sigZoneTop = h - mb - sigZone;
  const artworkBoxTop = mt;
  const artworkBoxDerived = sigZoneTop - gap - artworkBoxTop;

  const artworkBoxW =
    layout.artworkMaxWidth != null ? Math.min(availableW, round(layout.artworkMaxWidth * w)) : availableW;
  const artworkBoxH =
    layout.artworkMaxHeight != null
      ? Math.min(artworkBoxDerived, round(layout.artworkMaxHeight * h))
      : artworkBoxDerived;

  const artworkBox: Box = { x: mx, y: artworkBoxTop, width: artworkBoxW, height: artworkBoxH };

  // Contain-fit the artwork into the box (preserve aspect, no crop).
  const scale = Math.min(artworkBoxW / artwork.w, artworkBoxH / artwork.h);
  const artworkOut = { width: round(artwork.w * scale), height: round(artwork.h * scale) };
  const artworkPos = {
    x: mx + round((availableW - artworkOut.width) / 2),
    y: artworkBoxTop + round((artworkBoxH - artworkOut.height) / 2),
  };

  const signatureBox: Box | null = hasSignature
    ? { x: mx, y: sigZoneTop, width: availableW, height: sigZone }
    : null;

  return { artworkBox, signatureBox, artworkOut, artworkPos, scale };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/print-assets-prepare.test.ts`
Expected: PASS — all `resolvePlacement` cases green (the pre-existing crop tests still pass; they are removed in Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/lib/print-assets-prepare.ts src/lib/print-assets-prepare.test.ts
git commit -m "feat(print-assets): add proportional layout placement math"
```

---

### Task 2: Layout validators (replace crop guards)

Replace the crop-specific validators (`validateCropAspect`, `validateNoEnlargement`, `validateProfileCoverage`) with layout validators that run before Sharp. Keep the file compiling for downstream callers by removing only unused exports (no external caller imports the three removed functions — confirmed by grep).

**Files:**
- Modify: `src/lib/print-assets-prepare.ts` (remove 3 crop validators, add 3 layout validators)
- Modify: `src/lib/print-assets-prepare.test.ts` (remove crop-validator `describe` blocks, add layout-validator tests)

**Interfaces:**
- Consumes: `PrintLayout`, `Placement`, `resolvePlacement` (Task 1); `DerivativeProfile` (existing)
- Produces: `validateLayoutFractions(layout): string[]`, `validateVerticalFit(layout, target, hasSignature): string[]`, `validateNoUpscale(layout, target, artwork, hasSignature): string[]`
- Removes: `validateCropAspect`, `validateNoEnlargement`, `validateProfileCoverage` (and their tests)

- [ ] **Step 1: Replace the failing tests**

In `src/lib/print-assets-prepare.test.ts`:

1. Remove the import entries `validateCropAspect`, `validateNoEnlargement`, `validateProfileCoverage` from the top import block.
2. Delete the entire `describe('validateCropAspect', …)`, `describe('validateNoEnlargement', …)`, and `describe('validateProfileCoverage', …)` blocks.
3. Add `validateLayoutFractions`, `validateVerticalFit`, `validateNoUpscale` to the top import block.
4. Append:

```ts
const VALID: PrintLayout = {
  sideMargin: 0.1,
  topMargin: 0.1,
  bottomMargin: 0.1,
  gapAboveSignature: 0.05,
  signatureZoneHeight: 0.05,
};

describe('validateLayoutFractions', () => {
  it('reports no errors for fractions in [0, 1]', () => {
    expect(validateLayoutFractions(VALID)).toEqual([]);
  });

  it('rejects a fraction above 1', () => {
    const errors = validateLayoutFractions({ ...VALID, topMargin: 1.5 });
    expect(errors.some((e) => e.includes('topMargin'))).toBe(true);
  });

  it('rejects a negative fraction', () => {
    const errors = validateLayoutFractions({ ...VALID, sideMargin: -0.1 });
    expect(errors.some((e) => e.includes('sideMargin'))).toBe(true);
  });
});

describe('validateVerticalFit', () => {
  it('reports no errors when margins + gap + signature fit the canvas height', () => {
    expect(validateVerticalFit(VALID, { w: 1000, h: 1000 }, true)).toEqual([]);
  });

  it('fails when the vertical stack overflows the canvas', () => {
    // 10+10+5+5+10 = 40% — fine on 1000, but force an impossible stack:
    const layout: PrintLayout = { ...VALID, topMargin: 0.6, bottomMargin: 0.6 };
    const errors = validateVerticalFit(layout, { w: 1000, h: 1000 }, false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('collapses gap + signature when hasSignature is false', () => {
    // Would overflow only if gap+signature counted — they must not when false.
    const layout: PrintLayout = { ...VALID, gapAboveSignature: 0.9, signatureZoneHeight: 0.9 };
    expect(validateVerticalFit(layout, { w: 1000, h: 1000 }, false)).toEqual([]);
  });
});

describe('validateNoUpscale', () => {
  it('accepts an artwork at least as large as its box in the limiting dimension', () => {
    // box ~700 tall, artwork 800 tall → scale < 1
    expect(validateNoUpscale(VALID, { w: 1000, h: 1000 }, { w: 800, h: 800 }, true)).toEqual([]);
  });

  it('rejects an artwork that would be upscaled', () => {
    const errors = validateNoUpscale(VALID, { w: 1000, h: 1000 }, { w: 50, h: 50 }, true);
    expect(errors.some((e) => /upscale|enlarge/i.test(e))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/print-assets-prepare.test.ts`
Expected: FAIL — the three new validators are not exported; the removed imports also leave stale references until Step 3.

- [ ] **Step 3: Replace the validators in `src/lib/print-assets-prepare.ts`**

Delete the entire `// ── Crop / enlargement guards ──` section (`validateCropAspect`, `validateNoEnlargement`) and the `validateProfileCoverage` function (under the tracked-config section). In place of the crop guards section, add:

```ts
// ── Layout validation (runs before Sharp) ────────────────────────────────────

const LAYOUT_FIELDS: (keyof PrintLayout)[] = [
  'sideMargin',
  'topMargin',
  'bottomMargin',
  'gapAboveSignature',
  'signatureZoneHeight',
];

/** Every required layout fraction is a finite number in [0, 1]. Returns error strings (empty = valid). */
export function validateLayoutFractions(layout: PrintLayout): string[] {
  const errors: string[] = [];
  for (const field of LAYOUT_FIELDS) {
    const v = layout[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      errors.push(`Layout field "${field}" must be a fraction in [0, 1], got ${JSON.stringify(v)}`);
    }
  }
  for (const field of ['artworkMaxWidth', 'artworkMaxHeight'] as const) {
    const v = layout[field];
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
      errors.push(`Optional layout field "${field}" must be a fraction in [0, 1] when set, got ${JSON.stringify(v)}`);
    }
  }
  return errors;
}

/**
 * The vertical stack (topMargin + artwork box + gap + signatureZone + bottomMargin)
 * must fit the canvas height for every active profile. Returns error strings.
 */
export function validateVerticalFit(
  layout: PrintLayout,
  target: { w: number; h: number },
  hasSignature: boolean,
): string[] {
  const placement = resolvePlacement(layout, target, { w: 1, h: 1 }, hasSignature);
  const errors: string[] = [];
  // artworkBox.y + height must not run past the signature zone top (or bottom margin).
  const limit = placement.signatureBox ? placement.signatureBox.y : target.h;
  if (placement.artworkBox.y + placement.artworkBox.height > limit) {
    errors.push(
      `Layout overflows canvas ${target.w}x${target.h}: artwork box bottom ` +
        `${placement.artworkBox.y + placement.artworkBox.height} exceeds limit ${limit}`,
    );
  }
  if (placement.artworkBox.height <= 0) {
    errors.push(`Layout leaves no room for artwork on canvas ${target.w}x${target.h}`);
  }
  return errors;
}

/**
 * Fail preparation when the artwork would be upscaled (contain scale > 1).
 * The artwork source must be at least as large as its box in the limiting dimension.
 */
export function validateNoUpscale(
  layout: PrintLayout,
  target: { w: number; h: number },
  artwork: { w: number; h: number },
  hasSignature: boolean,
): string[] {
  const placement = resolvePlacement(layout, target, artwork, hasSignature);
  if (placement.scale > 1) {
    return [
      `Cannot upscale artwork ${artwork.w}x${artwork.h} into box ` +
        `${placement.artworkBox.width}x${placement.artworkBox.height} on canvas ` +
        `${target.w}x${target.h} (scale ${placement.scale.toFixed(4)})`,
    ];
  }
  return [];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/print-assets-prepare.test.ts`
Expected: PASS — layout-validator tests green; crop tests gone.

- [ ] **Step 5: Commit**

```bash
git add src/lib/print-assets-prepare.ts src/lib/print-assets-prepare.test.ts
git commit -m "refactor(print-assets): replace crop guards with layout validators"
```

---

### Task 3: Config + manifest types for composition

Reshape `PrepareConfig` (drop `profiles`, add `artwork`/`background`/`format`/`layout`/`signature`), extend the manifest additively (`signatureSha256`, `layout`, per-derivative `artworkBoxPx`/`signatureBoxPx`), and extend `buildManifest`/`validateManifest` to carry and self-check the new fields.

**Files:**
- Modify: `src/lib/print-assets-prepare.ts` (config + manifest types, `buildManifest`, `validateManifest`)
- Modify: `src/lib/print-assets-prepare.test.ts` (update `CONFIG`, `makeManifestInputs`, manifest tests)

**Interfaces:**
- Consumes: `PrintLayout`, `Placement`, `resolvePlacement` (Tasks 1–2); existing manifest types
- Produces: new `PrepareConfig` shape; `ManifestLayout`; `PrepareManifest.signatureSha256` / `.layout`; `ManifestDerivative.artworkBoxPx` / `.signatureBoxPx`; `BuildManifestInput.signatureSha256` / `.layout` / extended `derivativeMeta`

- [ ] **Step 1: Update the tests for the new config + manifest shape**

In `src/lib/print-assets-prepare.test.ts`, replace the `CONFIG` constant and `makeManifestInputs`, and update the manifest `describe` blocks. Replace the existing `CONFIG` / `makeManifestInputs` / `buildManifest` / `validateManifest` blocks with:

```ts
const LAYOUT_CONFIG: PrintLayout = {
  sideMargin: 0.1,
  topMargin: 0.1,
  bottomMargin: 0.1,
  gapAboveSignature: 0.05,
  signatureZoneHeight: 0.05,
};

const CONFIG: PrepareConfig = {
  product: 'fap01',
  artwork: 'design/print-assets/fap01/artwork-master.png',
  background: '#E8E0D7',
  format: 'jpg',
  layout: LAYOUT_CONFIG,
  signature: { svg: 'design/print-assets/fap01/signature.svg' },
};

function makeManifestInputs() {
  const profiles = distinctProfiles([
    { variantKey: '30x40:false:false:none', w: 1000, h: 1000 },
    { variantKey: '30x40:true:false:natural', w: 1000, h: 1000 },
    { variantKey: '50x70:true:false:black', w: 1400, h: 2000 },
  ]);
  return {
    product: 'fap01',
    revision: '2026-07-16-r1',
    sourceSha256: 'a'.repeat(64),
    sourceWidth: 1600,
    sourceHeight: 1600,
    signatureSha256: 'd'.repeat(64),
    layout: LAYOUT_CONFIG,
    hasSignature: true,
    profiles,
    derivativeMeta: {
      '1000x1000': {
        sha256: 'b'.repeat(64),
        byteSize: 111,
        format: 'jpg' as const,
        placement: resolvePlacement(LAYOUT_CONFIG, { w: 1000, h: 1000 }, { w: 1600, h: 1600 }, true),
      },
      '1400x2000': {
        sha256: 'c'.repeat(64),
        byteSize: 222,
        format: 'jpg' as const,
        placement: resolvePlacement(LAYOUT_CONFIG, { w: 1400, h: 2000 }, { w: 1600, h: 1600 }, true),
      },
    },
  };
}

describe('buildManifest', () => {
  it('builds one derivative per distinct profile with its r2Key + placement', () => {
    const manifest = buildManifest(makeManifestInputs());
    expect(manifest.derivatives).toHaveLength(2);
    const byKey = new Map(manifest.derivatives.map((d) => [d.profileKey, d]));
    expect(byKey.get('1000x1000')).toMatchObject({
      width: 1000,
      height: 1000,
      format: 'jpg',
      contentType: 'image/jpeg',
      sha256: 'b'.repeat(64),
      byteSize: 111,
      r2Key: 'prints/fap01/2026-07-16-r1/1000x1000-' + 'b'.repeat(64) + '.jpg',
    });
    expect(byKey.get('1000x1000')?.artworkBoxPx).toMatchObject({ x: 100, width: 800 });
    expect(byKey.get('1000x1000')?.signatureBoxPx).toMatchObject({ y: 850, height: 50 });
  });

  it('records the layout snapshot and both layer hashes', () => {
    const manifest = buildManifest(makeManifestInputs());
    expect(manifest.sourceSha256).toBe('a'.repeat(64));
    expect(manifest.signatureSha256).toBe('d'.repeat(64));
    expect(manifest.layout).toMatchObject({
      rendererVersion: expect.any(String),
      background: '#E8E0D7',
      artworkSha256: 'a'.repeat(64),
      signatureSha256: 'd'.repeat(64),
    });
  });

  it('maps every variant_key to its profile in assignments', () => {
    const manifest = buildManifest(makeManifestInputs());
    const assignmentByVariant = new Map(manifest.assignments.map((a) => [a.variantKey, a.profileKey]));
    expect(assignmentByVariant.get('30x40:false:false:none')).toBe('1000x1000');
    expect(assignmentByVariant.get('50x70:true:false:black')).toBe('1400x2000');
  });
});

describe('validateManifest', () => {
  it('reports no errors for a self-consistent manifest', () => {
    const manifest = buildManifest(makeManifestInputs());
    expect(validateManifest(manifest, CONFIG)).toEqual([]);
  });

  it('round-trips through JSON without losing structure', () => {
    const manifest = buildManifest(makeManifestInputs());
    const roundTripped = JSON.parse(JSON.stringify(manifest));
    expect(validateManifest(roundTripped, CONFIG)).toEqual([]);
    expect(roundTripped).toEqual(manifest);
  });

  it('fails when a derivative dimension does not match its profile key', () => {
    const manifest = buildManifest(makeManifestInputs());
    manifest.derivatives.find((d) => d.profileKey === '1000x1000')!.width = 9999;
    expect(validateManifest(manifest, CONFIG).some((e) => e.includes('1000x1000'))).toBe(true);
  });

  it('fails when a recorded artworkBoxPx does not match a recomputed placement', () => {
    const manifest = buildManifest(makeManifestInputs());
    manifest.derivatives.find((d) => d.profileKey === '1000x1000')!.artworkBoxPx.x = 0;
    expect(validateManifest(manifest, CONFIG).some((e) => /artworkBox|placement/i.test(e))).toBe(true);
  });
});
```

Update the top import to include `resolvePlacement` and `type PrintLayout` (already added in Task 1).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/print-assets-prepare.test.ts`
Expected: FAIL — `PrepareConfig` has no `artwork`/`layout`; `buildManifest` input/return shapes mismatch.

- [ ] **Step 3: Reshape config + manifest types**

In `src/lib/print-assets-prepare.ts`:

Replace the `GallerySlotConfig` + `PrepareConfig` block with:

```ts
/** Storefront gallery slot — source fulfilment profile + public/uploads stem. */
export interface GallerySlotConfig {
  sourceProfile: string;
  uploadStem: string;
}

/** Optional SVG signature layer (rendered from vector, never cut from a JPG). */
export interface SignatureConfig {
  svg: string; // path relative to repo root, under design/
}

/**
 * Product-level composition config (one layout adapts to every profile).
 * Replaces the per-profile crop map. sourceSha256/sourceWidth/sourceHeight in
 * the manifest refer to the `artwork` master named here.
 */
export interface PrepareConfig {
  product: string;
  artwork: string; // path to artwork-only master, under design/
  background: string; // hex colour, e.g. "#E8E0D7"
  format: DerivativeFormat; // product-level output format
  layout: PrintLayout;
  signature?: SignatureConfig;
  /** Optional storefront gallery slots (operator `print-assets:gallery`). */
  gallery?: Record<string, GallerySlotConfig>;
}
```

Replace the `ManifestDerivative`, `PrepareManifest`, `BuildManifestInput` interfaces and the `buildManifest` / `validateManifest` functions with:

```ts
export interface ManifestDerivative {
  profileKey: string;
  width: number;
  height: number;
  format: DerivativeFormat;
  contentType: string;
  sha256: string;
  byteSize: number;
  r2Key: string;
  /** Resolved artwork box on this canvas (audit/repro). */
  artworkBoxPx: Box;
  /** Resolved signature zone on this canvas, or null. */
  signatureBoxPx: Box | null;
}

export interface ManifestAssignment {
  variantKey: string;
  profileKey: string;
}

/** Layout snapshot for reproducibility/audit (the operator's "layout manifest"). */
export interface ManifestLayout {
  /** Bumped on any change to the compose pipeline; gates reproducibility claims. */
  rendererVersion: string;
  background: string; // hex, as configured
  artworkSha256: string;
  signatureSha256: string | null;
  layout: PrintLayout; // the fractions, as configured
}

export interface PrepareManifest {
  product: string;
  revision: string;
  sourceSha256: string; // artwork master file hash
  sourceWidth: number; // artwork master width
  sourceHeight: number; // artwork master height
  signatureSha256: string | null; // signature.svg file hash, or null
  layout: ManifestLayout;
  derivatives: ManifestDerivative[];
  assignments: ManifestAssignment[];
}

/** Bump when the Sharp compose pipeline changes in any way that affects output bytes. */
export const COMPOSE_RENDERER_VERSION = '2.0.0';

export interface BuildManifestInput {
  product: string;
  revision: string;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  signatureSha256: string | null;
  layout: PrintLayout;
  background: string;
  hasSignature: boolean;
  profiles: DerivativeProfile[];
  /** Per-profile compose output + its resolved placement. */
  derivativeMeta: Record<
    string,
    {
      sha256: string;
      byteSize: number;
      format: DerivativeFormat;
      placement: Placement;
    }
  >;
}

export function buildManifest(input: BuildManifestInput): PrepareManifest {
  const derivatives: ManifestDerivative[] = input.profiles.map((profile) => {
    const meta = input.derivativeMeta[profile.profileKey];
    if (!meta) {
      throw new Error(`Missing derivative output for profile ${profile.profileKey}`);
    }
    return {
      profileKey: profile.profileKey,
      width: profile.w,
      height: profile.h,
      format: meta.format,
      contentType: CONTENT_TYPE_BY_FORMAT[meta.format],
      sha256: meta.sha256,
      byteSize: meta.byteSize,
      r2Key: buildR2Key(input.product, input.revision, profile.w, profile.h, meta.sha256, meta.format),
      artworkBoxPx: meta.placement.artworkBox,
      signatureBoxPx: meta.placement.signatureBox,
    };
  });

  const assignments: ManifestAssignment[] = input.profiles.flatMap((profile) =>
    profile.variantKeys.map((variantKey) => ({ variantKey, profileKey: profile.profileKey })),
  );

  return {
    product: input.product,
    revision: input.revision,
    sourceSha256: input.sourceSha256,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    signatureSha256: input.signatureSha256,
    layout: {
      rendererVersion: COMPOSE_RENDERER_VERSION,
      background: input.background,
      artworkSha256: input.sourceSha256,
      signatureSha256: input.signatureSha256,
      layout: input.layout,
    },
    derivatives,
    assignments,
  };
}

/**
 * Validate a manifest against its tracked config + its own internal consistency:
 * every configured profile has exactly one derivative, derivative dims match the
 * profile key, and each derivative's recorded artworkBoxPx equals a placement
 * recomputed from the manifest's layout + source dims. Returns error strings.
 */
export function validateManifest(manifest: PrepareManifest, config: PrepareConfig): string[] {
  const errors: string[] = [];
  const byProfileKey = new Map(manifest.derivatives.map((d) => [d.profileKey, d]));

  for (const derivative of manifest.derivatives) {
    const [expectedW, expectedH] = derivative.profileKey.split('x').map(Number);
    if (derivative.width !== expectedW || derivative.height !== expectedH) {
      errors.push(
        `Derivative for profile ${derivative.profileKey} has dimensions ${derivative.width}x${derivative.height}, ` +
          `expected ${expectedW}x${expectedH}`,
      );
    }
    const expectedContentType = CONTENT_TYPE_BY_FORMAT[derivative.format];
    if (derivative.contentType !== expectedContentType) {
      errors.push(
        `Derivative for profile ${derivative.profileKey} has contentType "${derivative.contentType}", ` +
          `expected "${expectedContentType}" for format ${derivative.format}`,
      );
    }
    // Self-consistency: recompute the placement from the recorded layout + source dims.
    const recomputed = resolvePlacement(
      manifest.layout.layout,
      { w: derivative.width, h: derivative.height },
      { w: manifest.sourceWidth, h: manifest.sourceHeight },
      manifest.signatureSha256 != null,
    );
    if (
      recomputed.artworkBox.x !== derivative.artworkBoxPx.x ||
      recomputed.artworkBox.y !== derivative.artworkBoxPx.y ||
      recomputed.artworkBox.width !== derivative.artworkBoxPx.width ||
      recomputed.artworkBox.height !== derivative.artworkBoxPx.height
    ) {
      errors.push(
        `Derivative for profile ${derivative.profileKey} has artworkBoxPx ` +
          `${JSON.stringify(derivative.artworkBoxPx)} that does not match recomputed ` +
          `${JSON.stringify(recomputed.artworkBox)} (layout/source drift)`,
      );
    }
  }

  return errors;
}
```

Remove the now-unused `ManifestLayout` duplicate if the old `validateManifest` referenced `config.profiles` — it no longer does (config has no `profiles`). The `config` param remains in the signature for future use and call-site compatibility.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/print-assets-prepare.test.ts`
Expected: PASS — all manifest tests green with the new shape.

- [ ] **Step 5: Typecheck the whole package (catches the script callers)**

Run: `npm run typecheck`
Expected: FAIL with errors in `scripts/print-assets-prepare.ts` (the old config/crop usage). Task 5 fixes those. If errors appear anywhere else (upload/verify/publish/gallery), stop — that means an unexpected consumer; report it before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/print-assets-prepare.ts src/lib/print-assets-prepare.test.ts
git commit -m "feat(print-assets): composition config + additive manifest layout"
```

---

### Task 4: Sharp compose pipeline

Rewrite the Sharp derivative generator from crop-and-resize to layer composition. Add a focused smoke test with generated fixtures (the one runnable check for the Sharp path — the pure math is covered in Tasks 1–2).

**Files:**
- Modify: `scripts/lib/prepare-derivatives.ts` (replace `generateDerivative` with `composeDerivative`; keep `writeDerivative`, `prepareOutputDir`, `DerivativeResult`)
- Create: `scripts/lib/prepare-derivatives.test.ts`

**Interfaces:**
- Consumes: `Placement`, `PrintLayout`, `DerivativeFormat` (Tasks 1, 3)
- Produces: `composeDerivative(input: ComposeInput): Promise<DerivativeResult>`, `ComposeInput` — called by Task 5

- [ ] **Step 1: Write the failing Sharp smoke test**

Create `scripts/lib/prepare-derivatives.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { composeDerivative } from './prepare-derivatives';
import type { PrintLayout, Placement } from '../../src/lib/print-assets-prepare';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'));
const ARTWORK = path.join(TMP, 'artwork.png');
const SIG = path.join(TMP, 'sig.svg');

const LAYOUT: PrintLayout = {
  sideMargin: 0.1,
  topMargin: 0.1,
  bottomMargin: 0.1,
  gapAboveSignature: 0.05,
  signatureZoneHeight: 0.05,
};

beforeAll(async () => {
  // A solid-red 200x200 artwork master.
  await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } })
    .png()
    .toFile(ARTWORK);
  // A 100x20 solid-blue signature SVG.
  fs.writeFileSync(
    SIG,
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20"><rect width="100" height="20" fill="#0000ff"/></svg>',
  );
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function pixel(buffer: Buffer, x: number, y: number, width: number, channels = 3) {
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * width + x) * channels;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

describe('composeDerivative', () => {
  it('produces a canvas at exact target dimensions', async () => {
    const placement: Placement = {
      artworkBox: { x: 100, y: 100, width: 800, height: 700 },
      signatureBox: { x: 100, y: 850, width: 800, height: 50 },
      artworkOut: { width: 200, height: 200 },
      artworkPos: { x: 400, y: 350 },
      scale: 1,
    };
    const result = await composeDerivative({
      artworkPath: ARTWORK,
      signatureSvgPath: SIG,
      background: '#00ff00',
      placement,
      target: { w: 1000, h: 1000 },
      format: 'jpg',
    });
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
    expect(result.format).toBe('jpg');
  });

  it('fills the canvas background where no artwork or signature is drawn', async () => {
    const placement: Placement = {
      artworkBox: { x: 100, y: 100, width: 800, height: 700 },
      signatureBox: { x: 100, y: 850, width: 800, height: 50 },
      artworkOut: { width: 200, height: 200 },
      artworkPos: { x: 400, y: 350 },
      scale: 1,
    };
    const result = await composeDerivative({
      artworkPath: ARTWORK,
      signatureSvgPath: SIG,
      background: '#00ff00',
      placement,
      target: { w: 1000, h: 1000 },
      format: 'jpg',
    });
    // Top-left corner is pure background (green).
    const [r, g, b] = await pixel(result.buffer, 5, 5, 1000);
    expect([r, g, b]).toEqual([0, 255, 0]);
  });

  it('composites the artwork at its resolved position', async () => {
    const placement: Placement = {
      artworkBox: { x: 100, y: 100, width: 800, height: 700 },
      signatureBox: { x: 100, y: 850, width: 800, height: 50 },
      artworkOut: { width: 200, height: 200 },
      artworkPos: { x: 400, y: 350 },
      scale: 1,
    };
    const result = await composeDerivative({
      artworkPath: ARTWORK,
      signatureSvgPath: SIG,
      background: '#00ff00',
      placement,
      target: { w: 1000, h: 1000 },
      format: 'jpg',
    });
    // Centre of the 200x200 artwork placed at (400,350) → (500,450) is red.
    const [r, g, b] = await pixel(result.buffer, 500, 450, 1000);
    expect([r, g, b]).toEqual([255, 0, 0]);
  });

  it('is byte-deterministic across two runs', async () => {
    const placement: Placement = {
      artworkBox: { x: 100, y: 100, width: 800, height: 700 },
      signatureBox: { x: 100, y: 850, width: 800, height: 50 },
      artworkOut: { width: 200, height: 200 },
      artworkPos: { x: 400, y: 350 },
      scale: 1,
    };
    const input = {
      artworkPath: ARTWORK,
      signatureSvgPath: SIG,
      background: '#00ff00',
      placement,
      target: { w: 1000, h: 1000 },
      format: 'jpg' as const,
    };
    const a = await composeDerivative(input);
    const b = await composeDerivative(input);
    expect(a.sha256).toBe(b.sha256);
  });

  it('composes without a signature when signatureSvgPath is null', async () => {
    const placement: Placement = {
      artworkBox: { x: 100, y: 100, width: 800, height: 800 },
      signatureBox: null,
      artworkOut: { width: 200, height: 200 },
      artworkPos: { x: 400, y: 400 },
      scale: 1,
    };
    const result = await composeDerivative({
      artworkPath: ARTWORK,
      signatureSvgPath: null,
      background: '#00ff00',
      placement,
      target: { w: 1000, h: 1000 },
      format: 'jpg',
    });
    expect(result.byteSize).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/lib/prepare-derivatives.test.ts`
Expected: FAIL — `composeDerivative` is not exported (the module still exports `generateDerivative`).

- [ ] **Step 3: Rewrite the Sharp pipeline**

Replace the entire `generateDerivative` function (and its `CropRegion` interface) in `scripts/lib/prepare-derivatives.ts` with:

```ts
import type { DerivativeFormat, Placement } from '../../src/lib/print-assets-prepare';

export interface ComposeInput {
  artworkPath: string;
  signatureSvgPath: string | null;
  background: string; // hex "#RRGGBB"
  placement: Placement; // from resolvePlacement (src/lib/print-assets-prepare.ts)
  target: { w: number; h: number };
  format: DerivativeFormat;
}

export interface DerivativeResult {
  sha256: string;
  byteSize: number;
  format: DerivativeFormat;
  buffer: Buffer;
}

/**
 * Compose one exact-pixel Prodigi derivative by layering the artwork master and
 * (optionally) an SVG signature onto a solid background canvas, using a resolved
 * proportional placement. Pure layout math lives in src/lib/print-assets-prepare.ts
 * and is validated by the caller before this runs Sharp.
 *
 * Deterministic: fixed JPEG quality / chroma / mozjpeg, fixed PNG settings, and a
 * fixed input file + placement → byte-identical output across runs. Sharp
 * colour-manages the artwork into sRGB and `.withMetadata()` embeds the output
 * sRGB profile.
 *
 * An RGBA artwork master is acceptable here (unlike the old crop path): alpha
 * composites onto the configured opaque background, and the output is flattened —
 * no transparency reaches Prodigi.
 */
export async function composeDerivative(input: ComposeInput): Promise<DerivativeResult> {
  const { artworkPath, signatureSvgPath, background, placement, target, format } = input;

  // 1. Base canvas = exact target pixels, filled with the configured background.
  const canvas = sharp({
    create: { width: target.w, height: target.h, channels: 3, background },
  });

  // 2. Artwork: resize to the contain-computed output dims and place centred in its box.
  const artworkLayer = await sharp(artworkPath)
    .resize(placement.artworkOut.width, placement.artworkOut.height, { fit: 'fill' })
    .toBuffer();

  const overlays: sharp.OverlayOptions[] = [
    { input: artworkLayer, left: placement.artworkPos.x, top: placement.artworkPos.y },
  ];

  // 3. Signature: rasterise the SVG contained into its zone, place centred in the zone.
  if (signatureSvgPath && placement.signatureBox) {
    const zone = placement.signatureBox;
    const sigLayer = await sharp(signatureSvgPath)
      .resize(zone.width, zone.height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();
    overlays.push({ input: sigLayer, left: zone.x, top: zone.y });
  }

  let pipeline = canvas.composite(overlays).withMetadata();

  if (format === 'jpg') {
    pipeline = pipeline.flatten({ background }).jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: false });
  }

  const buffer = await pipeline.toBuffer();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  return { sha256, byteSize: buffer.byteLength, format, buffer };
}
```

Update the module's top doc-comment to say "Sharp composition for `scripts/print-assets-prepare.ts`" instead of "crop/resize". Leave `writeDerivative` and `prepareOutputDir` unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/lib/prepare-derivatives.test.ts`
Expected: PASS — dimensions correct, background green at corner, artwork red at centre, byte-deterministic, signatureless path works.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/prepare-derivatives.ts scripts/lib/prepare-derivatives.test.ts
git commit -m "feat(print-assets): rewrite derivative generation as layer composition"
```

---

### Task 5: Rewire the prepare CLI

Update the operator script to load the new config, hash the artwork + signature, resolve a placement per profile (via the lib math), compose each derivative, and write the extended manifest.

**Files:**
- Modify: `scripts/print-assets-prepare.ts`

**Interfaces:**
- Consumes: `PrepareConfig`, `resolvePlacement`, `validateLayoutFractions`, `validateVerticalFit`, `validateNoUpscale`, `buildManifest`, `validateManifest`, `distinctProfiles` (Tasks 1–3); `composeDerivative` (Task 4); existing `activeVariantDimensions`, `loadSupabaseClient`, `revisionDir`, cli helpers
- Produces: a working `npm run print-assets:prepare` against the new config shape

- [ ] **Step 1: Rewrite the script**

Replace the imports and the `loadConfig` + `main` of `scripts/print-assets-prepare.ts` with:

```ts
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
  buildManifest,
  distinctProfiles,
  refuseOverwrite,
  validateLayoutFractions,
  validateManifest,
  validateNoUpscale,
  validateVerticalFit,
  type PrepareConfig,
} from '../src/lib/print-assets-prepare';
import { composeDerivative, prepareOutputDir, writeDerivative } from './lib/prepare-derivatives';
import { activeVariantDimensions } from './lib/db-variants';
import { loadSupabaseClient } from './lib/script-env';
import { getArg, hasFlag, revisionDir, ROOT } from './lib/print-assets-cli';

/** Load config/print-assets/{productId}.json. Fails loudly if missing/malformed. */
function loadConfig(productId: string): PrepareConfig {
  const configPath = path.join(ROOT, 'config', 'print-assets', `${productId}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No tracked config for product "${productId}" — expected ${path.relative(ROOT, configPath)}. ` +
        'Author it first: artwork path, background, format, and a proportional layout ' +
        '(see docs/superpowers/specs/2026-07-16-proportional-print-composition-design.md).',
    );
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as PrepareConfig;
  if (parsed.product !== productId) {
    throw new Error(`Config ${configPath} declares product "${parsed.product}", expected "${productId}"`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const productId = getArg('product');
  const revision = getArg('revision');
  const sourcePath = getArg('source'); // accepted for CLI parity; resolved from config.artwork if absent
  const force = hasFlag('force');
  const dryRun = hasFlag('dry-run');

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');
  if (!revision) throw new Error('Missing --revision (e.g. --revision 2026-07-16-r1)');

  console.log(`print-assets:prepare — product=${productId} revision=${revision}`);

  const config = loadConfig(productId);

  const artworkPath = sourcePath ? path.resolve(sourcePath) : path.resolve(ROOT, config.artwork);
  if (!fs.existsSync(artworkPath)) {
    throw new Error(`Artwork master not found: ${artworkPath} (config.artwork = ${config.artwork})`);
  }
  const signaturePath = config.signature ? path.resolve(ROOT, config.signature.svg) : null;
  if (signaturePath && !fs.existsSync(signaturePath)) {
    throw new Error(`Signature SVG not found: ${signaturePath} (config.signature.svg = ${config.signature!.svg})`);
  }
  const hasSignature = signaturePath !== null;
  console.log(`  artwork: ${artworkPath}`);
  console.log(`  signature: ${signaturePath ?? '(none)'}`);

  // 1. Validate layout fractions before any per-profile work.
  const fractionErrors = validateLayoutFractions(config.layout);
  if (fractionErrors.length > 0) {
    throw new Error(`Invalid layout fractions:\n  - ${fractionErrors.join('\n  - ')}`);
  }

  // 2. Enumerate active variants → distinct dimension profiles.
  const supabase = loadSupabaseClient();
  const variantDims = await activeVariantDimensions(supabase, productId);
  const profiles = distinctProfiles(variantDims);
  console.log(`  ${variantDims.length} active variant(s) → ${profiles.length} distinct profile(s): ${profiles.map((p) => p.profileKey).join(', ')}`);

  // 3. Read the artwork master's dimensions + sha256.
  const sourceMeta = await sharp(artworkPath).metadata();
  const sourceWidth = sourceMeta.width ?? 0;
  const sourceHeight = sourceMeta.height ?? 0;
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error(`Could not decode artwork master dimensions: ${artworkPath}`);
  }
  const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(artworkPath)).digest('hex');
  const signatureSha256 = signaturePath
    ? crypto.createHash('sha256').update(fs.readFileSync(signaturePath)).digest('hex')
    : null;
  console.log(`  artwork dimensions: ${sourceWidth}x${sourceHeight}  sha256: ${sourceSha256.slice(0, 12)}…`);

  // 4. Validate vertical fit + no-upscale for EVERY profile before composing.
  const layoutErrors: string[] = [];
  for (const profile of profiles) {
    layoutErrors.push(
      ...validateVerticalFit(config.layout, { w: profile.w, h: profile.h }, hasSignature),
      ...validateNoUpscale(config.layout, { w: profile.w, h: profile.h }, { w: sourceWidth, h: sourceHeight }, hasSignature),
    );
  }
  if (layoutErrors.length > 0) {
    throw new Error(`Layout does not fit every profile:\n  - ${layoutErrors.join('\n  - ')}`);
  }
  console.log('  layout validated (vertical fit + no upscale across all profiles)');

  const outputDir = revisionDir(productId, revision);
  refuseOverwrite(outputDir, { exists: () => fs.existsSync(outputDir), force });

  if (dryRun) {
    console.log('\nDRY RUN — no derivatives generated, no files written.');
    console.log(`Would compose ${profiles.length} derivative(s) + manifest.json to ${path.relative(ROOT, outputDir)}/`);
    return;
  }

  // 5. Compose one derivative per distinct profile.
  const derivativeMeta: Record<string, { sha256: string; byteSize: number; format: typeof config.format; placement: ReturnType<typeof resolvePlacementFirst }> = {};
  prepareOutputDir(outputDir, { force });

  for (const profile of profiles) {
    const placement = resolvePlacementFor(config.layout, { w: profile.w, h: profile.h }, { w: sourceWidth, h: sourceHeight }, hasSignature);
    process.stdout.write(`  composing ${profile.profileKey}.${config.format} … `);
    const result = await composeDerivative({
      artworkPath,
      signatureSvgPath: signaturePath,
      background: config.background,
      placement,
      target: { w: profile.w, h: profile.h },
      format: config.format,
    });
    const filename = `${profile.profileKey}-${result.sha256}.${config.format}`;
    writeDerivative(path.join(outputDir, filename), result.buffer);
    derivativeMeta[profile.profileKey] = {
      sha256: result.sha256,
      byteSize: result.byteSize,
      format: result.format,
      placement,
    };
    console.log(`${(result.byteSize / 1024).toFixed(0)} KB → ${filename}`);

    // Review proof — small, visual-only, never uploaded.
    const proofPath = path.join(outputDir, `proof-${profile.profileKey}.jpg`);
    await sharp(result.buffer).resize({ width: 600 }).jpeg({ quality: 70 }).toFile(proofPath);
  }

  // 6. Build + validate the manifest, then write it.
  const manifest = buildManifest({
    product: productId,
    revision,
    sourceSha256,
    sourceWidth,
    sourceHeight,
    signatureSha256,
    layout: config.layout,
    background: config.background,
    hasSignature,
    profiles,
    derivativeMeta,
  });
  const manifestErrors = validateManifest(manifest, config);
  if (manifestErrors.length > 0) {
    throw new Error(`Manifest failed validation (this indicates a bug in prepare, not a config problem):\n  - ${manifestErrors.join('\n  - ')}`);
  }
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\nDone. ${profiles.length} derivative(s) + manifest written to ${path.relative(ROOT, outputDir)}/`);
  console.log('Review the proof-*.jpg files before running print-assets:upload (Phase 2b).');
}

// Thin wrappers so the per-profile placement type flows without importing the
// type twice in the derivativeMeta annotation above.
import { resolvePlacement } from '../src/lib/print-assets-prepare';
function resolvePlacementFor(...args: Parameters<typeof resolvePlacement>): ReturnType<typeof resolvePlacement> {
  return resolvePlacement(...args);
}
function resolvePlacementFirst(...args: Parameters<typeof resolvePlacement>): ReturnType<typeof resolvePlacement> {
  return resolvePlacement(...args);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

> Note: the `resolvePlacementFor` / `resolvePlacementFirst` wrappers and the late `import` exist only to keep the `derivativeMeta` type annotation readable. If the implementer prefers, move `import { resolvePlacement } from '../src/lib/print-assets-prepare'` to the top import block and type `derivativeMeta` as `Record<string, { sha256: string; byteSize: number; format: DerivativeFormat; placement: Placement }>` (importing `Placement` and `DerivativeFormat` types too) — that is the cleaner form and is acceptable.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS (clean). Any error here means a missed call site — fix before continuing.

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`
Expected: PASS — all print-asset tests green; no other suite regressed.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS (`next build --webpack` succeeds — the prepare scripts are not bundled into the Worker, but the build must remain green).

- [ ] **Step 5: Commit**

```bash
git add scripts/print-assets-prepare.ts
git commit -m "feat(print-assets): rewire prepare CLI to proportional composition"
```

---

### Task 6: Reshape the product config + authoring notes

Move `config/print-assets/fap01.json` to the new schema and update the README so the config reflects the composition model. The currently-published `fap01` assets (revision `2026-07-12-r1`, immutable in R2/DB) are unaffected — this config only governs the *next* prepare.

**Files:**
- Modify: `config/print-assets/fap01.json`
- Modify: `config/print-assets/README.md`

- [ ] **Step 1: Reshape `config/print-assets/fap01.json`**

Replace its contents with:

```json
{
  "_comment": "Proportional composition config (docs/superpowers/specs/2026-07-16-proportional-print-composition-design.md). Artwork is a clean painting master (no baked border); background + margins + signature zone are composed per-variant so every Prodigi aspect ratio preserves the same visual proportions. Source masters/signatures live under gitignored design/.",
  "product": "fap01",
  "artwork": "design/print-assets/fap01/artwork-master.png",
  "background": "#E8E0D7",
  "format": "jpg",
  "layout": {
    "sideMargin": 0.06,
    "topMargin": 0.06,
    "bottomMargin": 0.05,
    "gapAboveSignature": 0.022,
    "signatureZoneHeight": 0.028,
    "artworkMaxWidth": 0.85,
    "artworkMaxHeight": 0.76
  },
  "signature": {
    "svg": "design/print-assets/fap01/signature.svg"
  },
  "gallery": {
    "hero": { "sourceProfile": "8400x12000", "uploadStem": "fap-01" }
  }
}
```

> The exact fraction values are Anna's to tune against proofs; the values above are the spec's recommended starting point. `gallery.hero.sourceProfile` must match one of fap01's active profiles (the largest, `8400x12000`, as before).

- [ ] **Step 2: Update `config/print-assets/README.md`**

Rewrite it to describe the new schema: one `layout` per product (fractions of canvas), `artwork`/`background`/`format`/`signature` fields, that margins are fractions of the short side / height, that the signature is an optional SVG layer, and that the previously-published assets are immutable and unaffected by config changes. Point to the spec for the resolution math. Keep it short — a half-page authoring guide.

- [ ] **Step 3: Validate the config loads**

Run: `node -e "const c=require('./config/print-assets/fap01.json'); console.log(c.product, c.layout.sideMargin, c.signature.svg)"`
Expected: prints `fap01 0.06 design/print-assets/fap01/signature.svg` with no parse error.

- [ ] **Step 4: Commit**

```bash
git add config/print-assets/fap01.json config/print-assets/README.md
git commit -m "chore(print-assets): reshape fap01 config to proportional layout"
```

---

### Task 7: Docs + operator-gated proof

Update the docs that describe the prepare step, and record the operator gate for re-preparing `fap01` from a real artwork master + signature. The code is complete and tested by Task 6; this task is docs + the live proof.

**Files:**
- Modify: `docs/plans/print-asset-pipeline.md` (note the generation-step supersedes)
- Modify: `docs/print-asset-runbook.md` (new prepare inputs: artwork master + signature.svg + layout tuning)
- Modify: `AGENTS.md` (one-line update to the `print-assets:prepare` description)

- [ ] **Step 1: Note the supersession in `docs/plans/print-asset-pipeline.md`**

In the "Settled Architecture §1" section, add a dated note:

```markdown
> **Update 2026-07-16:** the *generation* step (crop of a flattened master) is
> superseded by proportional layer composition — see
> `docs/superpowers/specs/2026-07-16-proportional-print-composition-design.md`
> and `docs/superpowers/plans/2026-07-16-proportional-print-composition.md`.
> The exact-derivative, immutable-R2, atomic-publish, checkout-snapshot, and
> fail-closed contracts above are unchanged; only how a derivative's pixels are
> produced changed (crop → compose). The per-profile `crop` config is replaced by
> a single product-level `layout`.
```

- [ ] **Step 2: Update `docs/print-asset-runbook.md`**

In the "new artwork" procedure, replace the crop-config step with: place an artwork-only master (no baked border) + a `signature.svg` under `design/print-assets/{id}/`, author `config/print-assets/{id}.json` with a `layout`, run `print-assets:prepare`, **review the composed `proof-*.jpg`** (now showing artwork + background + signature placement), tune the layout fractions if margins/signature position need adjustment, then upload/verify/publish as before. Add a short "tuning the layout" subsection listing each fraction's effect.

- [ ] **Step 3: Update `AGENTS.md`**

In the operational-scripts paragraph, update the `print-assets:prepare` description from "prepare exact Prodigi print-area derivatives from an approved master" to "compose exact Prodigi print-area derivatives from an artwork master + background + SVG signature using a proportional layout". One sentence.

- [ ] **Step 4: Operator gate — re-prepare `fap01` from real assets**

This step requires Anna's real artwork-only master + `signature.svg` (operator-confirmed available). It is an operator gate, not an automated test:

- [ ] Place `design/print-assets/fap01/artwork-master.png` + `signature.svg`.
- [ ] Run `npm run print-assets:prepare -- --product fap01 --revision 2026-07-17-r1` against production Supabase.
- [ ] Review `design/print-assets/fap01/2026-07-17-r1/proof-*.jpg` with Anna; tune `config/print-assets/fap01.json` `layout` fractions and re-prepare until composition is approved across all aspect ratios.
- [ ] Stop after proof generation for Anna's visual approval. Upload, verify,
  publish, and Prodigi sandbox orders are a separate explicitly approved phase.

- [ ] **Step 5: Commit the docs**

```bash
git add docs/plans/print-asset-pipeline.md docs/print-asset-runbook.md AGENTS.md
git commit -m "docs(print-assets): proportional composition prepare step"
```

---

## Self-Review

**1. Spec coverage** — checked against `docs/superpowers/specs/2026-07-16-proportional-print-composition-design.md`:
- Core principle (layers not flattened master) → Tasks 4–5 (compose), 6 (config).
- Layout model + resolution math → Task 1 (`resolvePlacement`); validators → Task 2.
- Data shapes (config, `PrepareConfig`, manifest extension) → Task 3.
- Contracts preserved (R2, publish RPC, checkout, signed route, mapper, fail-closed) → "Untouched" list + Task 7 note; no task edits those files.
- Validation rules (fractions, vertical fit, no-upscale, manifest self-consistency) → Tasks 2–3.
- Loosened alpha restriction → Task 4 (`composeDerivative` accepts RGBA artwork; doc-comment states it).
- Determinism / ICC / `rendererVersion` → Task 4 (encoding + `.withMetadata()`), Task 3 (`COMPOSE_RENDERER_VERSION`).
- Operational impact (new designs; existing published unaffected) → Task 6 note, Task 7 operator gate.
- Non-goals (no admin UI, no focal-point, no runtime engine) → respected; none implemented.
- Deferred-to-plan items (sequencing, `rendererVersion` value) → resolved: clean cutover (only `fap01.json` exists), `rendererVersion = '2.0.0'`.

**2. Placeholder scan** — no "TBD"/"TODO"/"add validation" without code. Task 5 Step 1 offers an optional cleaner import form but the shown code is complete and runnable as-is. Task 7 Step 4 is an operator gate (checkboxes), consistent with the existing pipeline plan's operator gates — not a code placeholder.

**3. Type consistency** — `PrintLayout` / `Placement` / `Box` defined in Task 1, consumed unchanged in Tasks 2–5. `PrepareConfig` (Task 3) consumed by Tasks 5–6. `ComposeInput` (Task 4) consumed by Task 5. `BuildManifestInput` fields (`signatureSha256`, `layout`, `background`, `hasSignature`, `derivativeMeta[].placement`) in Task 3 match what Task 5 passes. `ManifestDerivative.artworkBoxPx` / `signatureBoxPx` produced in Task 3, asserted in Task 3 tests, and additive to the upload/verify/publish consumers (unchanged). Field-name decision (`sourceSha256` kept) is consistent across Tasks 3, 5, and the "Untouched" consumers.

**Sequencing note for the executor:** Tasks 1→2→3→4→5→6→7 are linearly dependent; do not reorder. After Task 3 the package will not typecheck until Task 5 lands (the old script callers) — that is expected; Task 3 Step 5 calls this out.
