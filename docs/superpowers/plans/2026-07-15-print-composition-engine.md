# Print Composition Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parametric, per-profile print-derivative composer (artwork + `#ded9c3` background + shared SVG signature, `contain`-fit) that produces a prepare-compatible manifest, so the existing upload/verify/publish pipeline runs unchanged and the studio stops hand-authoring per-size crops.

**Architecture:** A pure layout module (`src/lib/print-composition.ts`, no Sharp, Vitest-tested) resolves per-profile geometry from aspect-agnostic fractions. A Sharp module (`scripts/lib/compose-master.ts`) renders each profile's exact-pixel canvas (background fill → artwork `contain` → signature composite). A CLI (`scripts/print-assets-compose.ts`) mirrors `print-assets-prepare.ts`: enumerate active variants → dedupe profiles → compose each → write derivatives + `manifest.json` + proofs. Output is byte-for-byte consumable by the existing `print-assets:upload/verify/publish`.

**Tech Stack:** TypeScript, `sharp@0.34.5` (devDep, scripts-only), Vitest, `tsx`, Supabase service-role (variant enumeration). No new dependencies.

## Global Constraints

- **Sharp never imports into `src/lib/`** — it's a native binding incompatible with the Cloudflare Workers runtime that `src/lib/` bundles into. All Sharp code stays under `scripts/lib/`. `src/lib/print-composition.ts` is PURE (no Sharp, no fs) so it bundles safely and unit-tests without the binary. (Mirrors why `prepare-derivatives.ts` lives in `scripts/lib/` while its pure math lives in `src/lib/print-assets-prepare.ts`.)
- **Deterministic output** — fixed JPEG quality 92, `chromaSubsampling: '4:4:4'`, `mozjpeg: true`, no encoder jitter; same inputs → byte-identical output (matches `prepare-derivatives.ts`).
- **ICC embedded as sRGB** — composed derivatives embed the sRGB profile via `.withMetadata({ icc: 'srgb' })`, the standard for fine-art POD (Prodigi needs a profile to interpret colour, and Sharp strips ICC by default). Save artwork masters in sRGB. Full per-master colour-profile passthrough is a Phase-2 concern; the MVP guarantees the file isn't unprofiled rather than risking a wrong embedded profile.
- **Build stays `next build --webpack`** — never Turbopack (OpenNext/Workers constraint). Not touched by this plan, but do not regress it.
- **Reuse, don't rebuild** — `activeVariantDimensions`, `distinctProfiles`, `buildManifest`, `refuseOverwrite`, `revisionDir`, `getArg`/`hasFlag`, `prepareOutputDir`, `writeDerivative`, `DerivativeResult`, `DerivativeFormat` are all reused as-is.
- **Commit messages** end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; conventional-commit scopes (`feat(prints)`, `test(prints)`, `docs(prints)`).
- Spec: `docs/superpowers/specs/2026-07-15-print-composition-engine-design.md` (decision #2 revised to per-profile composition).

---

## File Structure

- **Create** `src/lib/print-composition.ts` — pure layout math, types, config parser + defaults. No I/O.
- **Create** `src/lib/print-composition.test.ts` — Vitest unit tests for geometry + parser.
- **Create** `scripts/lib/compose-master.ts` — Sharp composition module (the only new Sharp code).
- **Create** `scripts/lib/compose-master.test.ts` — Vitest test with synthetic Sharp fixtures.
- **Create** `scripts/print-assets-compose.ts` — operator CLI (mirrors `print-assets-prepare.ts`).
- **Modify** `package.json` — add `"print-assets:compose": "tsx scripts/print-assets-compose.ts"`.
- **Create** `config/print-composition/{signature.svg, fap01.json, README.md}` — tracked config assets.

Each task produces an independently testable, committable deliverable.

---

### Task 1: Pure layout math (geometry)

**Files:**
- Create: `src/lib/print-composition.ts`
- Test: `src/lib/print-composition.test.ts`

**Interfaces:**
- Produces: `Rect`, `CompositionLayout`, `PrintCompositionConfig`, `ComposedGeometry` types; `mmToPx(mm, dpi)`, `clampPx(value, minPx, maxPx)`, `containDimensions(srcW, srcH, maxW, maxH)`, `composeLayout(canvas, artwork, signature, config)`, and `DEFAULT_LAYOUT` / `BACKGROUND_DEFAULT` constants. Consumed by Task 3 (Sharp module) and Task 2 (parser merges `DEFAULT_LAYOUT`).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/print-composition.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  mmToPx,
  clampPx,
  containDimensions,
  composeLayout,
  DEFAULT_LAYOUT,
  BACKGROUND_DEFAULT,
} from './print-composition';

describe('mmToPx', () => {
  it('converts millimetres to pixels at a given DPI (rounded)', () => {
    expect(mmToPx(25.4, 300)).toBe(300);
    expect(mmToPx(18, 300)).toBe(213); // 212.598 → 213
    expect(mmToPx(55, 300)).toBe(650); // 649.6 → 650
  });
});

describe('clampPx', () => {
  it('clamps a value into [min, max]', () => {
    expect(clampPx(100, 10, 50)).toBe(50);
    expect(clampPx(5, 10, 50)).toBe(10);
    expect(clampPx(30, 10, 50)).toBe(30);
  });
});

describe('containDimensions', () => {
  it('scales a source to fit inside a box without cropping', () => {
    expect(containDimensions(2000, 1000, 1000, 1000)).toEqual({ width: 1000, height: 500 });
    expect(containDimensions(1000, 1000, 2000, 500)).toEqual({ width: 500, height: 500 });
  });
  it('never exceeds either box dimension', () => {
    const r = containDimensions(3000, 1000, 999, 999);
    expect(r.width).toBeLessThanOrEqual(999);
    expect(r.height).toBeLessThanOrEqual(999);
  });
});

describe('composeLayout', () => {
  const config = {
    product: 'fap01',
    artwork: 'design/prints/fap01-artwork.tif',
    background: BACKGROUND_DEFAULT,
    signature: { src: 'config/print-composition/signature.svg' },
    layout: DEFAULT_LAYOUT,
    opticalOffset: { x: 0, y: 0 },
  };
  const geo = composeLayout(
    { width: 3600, height: 4800 },
    { aspect: 0.7 },
    { aspect: 3 },
    config,
  );

  it('keeps the artwork fully inside the canvas', () => {
    const { left, top, width, height } = geo.artwork;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(3600);
    expect(top + height).toBeLessThanOrEqual(4800);
  });

  it('respects the artwork max-width / max-height fractions', () => {
    expect(geo.artwork.width).toBeLessThanOrEqual(3600 * DEFAULT_LAYOUT.artworkMaxWidthFrac);
    expect(geo.artwork.height).toBeLessThanOrEqual(4800 * DEFAULT_LAYOUT.artworkMaxHeightFrac);
  });

  it('horizontally centres the artwork (offset 0)', () => {
    const centre = geo.artwork.left + geo.artwork.width / 2;
    expect(Math.abs(centre - 1800)).toBeLessThanOrEqual(1);
  });

  it('places the signature below the artwork with a gap', () => {
    expect(geo.signature.top).toBeGreaterThanOrEqual(geo.artwork.top + geo.artwork.height);
  });

  it('is deterministic — same input yields identical output', () => {
    const again = composeLayout({ width: 3600, height: 4800 }, { aspect: 0.7 }, { aspect: 3 }, config);
    expect(again).toEqual(geo);
  });

  it('applies the optical offset to the artwork only', () => {
    const shifted = composeLayout(
      { width: 3600, height: 4800 },
      { aspect: 0.7 },
      { aspect: 3 },
      { ...config, opticalOffset: { x: -0.02, y: 0 } },
    );
    expect(shifted.artwork.left).toBeLessThan(geo.artwork.left);
    expect(shifted.signature).toEqual(geo.signature); // signature stays canvas-centred
  });

  it('throws when margins leave no room for the artwork', () => {
    expect(() =>
      composeLayout({ width: 10, height: 10 }, { aspect: 0.7 }, { aspect: 3 }, config),
    ).toThrow(/no room/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/print-composition.test.ts`
Expected: FAIL — `Cannot find module './print-composition'` (or `print-composition is not defined`).

- [ ] **Step 3: Write the implementation**

Create `src/lib/print-composition.ts`:

```ts
/**
 * Pure layout math for the print composition engine
 * (docs/superpowers/specs/2026-07-15-print-composition-engine-design.md).
 *
 * No Sharp, no filesystem — importable by the operator script AND by unit tests
 * without the native Sharp binary. The Sharp-touching composition lives in
 * scripts/lib/compose-master.ts; this module holds the deterministic geometry
 * the rest of the pipeline depends on.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Per-canvas layout knobs, expressed as fractions so one config renders at every print size. */
export interface CompositionLayout {
  /** Margin as a fraction of the canvas's shorter side, clamped to [minMarginMm, maxMarginMm]. */
  marginShortSideFrac: number;
  /** Artwork max width as a fraction of canvas width. */
  artworkMaxWidthFrac: number;
  /** Artwork max height as a fraction of canvas height (already excluding the signature zone). */
  artworkMaxHeightFrac: number;
  /** Signature height as a fraction of canvas height, clamped to [minSignatureMm, maxSignatureMm]. */
  signatureHeightFrac: number;
  /** Gap between artwork bottom and signature, fraction of canvas height, clamped to [min, max]Mm. */
  signatureGapFrac: number;
  minMarginMm: number;
  maxMarginMm: number;
  minSignatureMm: number;
  maxSignatureMm: number;
  minSignatureGapMm: number;
  maxSignatureGapMm: number;
  dpi: number;
}

export interface PrintCompositionConfig {
  product: string;
  /** Path to the artwork master (gitignored design/ tree), relative to repo root. */
  artwork: string;
  /** Solid canvas background, `#rrggbb`. Defaults to #ded9c3. */
  background: string;
  /** Shared signature SVG, relative to repo root. Signature is always horizontally centred. */
  signature: { src: string };
  layout: CompositionLayout;
  /** Per-artwork optical-centering nudge, fractions of canvas. 0/0 = none. */
  opticalOffset: { x: number; y: number };
}

export interface ComposedGeometry {
  canvas: { width: number; height: number };
  artwork: Rect;
  signature: Rect;
}

export const BACKGROUND_DEFAULT = '#ded9c3';

export const DEFAULT_LAYOUT: CompositionLayout = {
  marginShortSideFrac: 0.065,
  artworkMaxWidthFrac: 0.85,
  artworkMaxHeightFrac: 0.76,
  signatureHeightFrac: 0.028,
  signatureGapFrac: 0.022,
  minMarginMm: 18,
  maxMarginMm: 55,
  minSignatureMm: 8,
  maxSignatureMm: 20,
  minSignatureGapMm: 8,
  maxSignatureGapMm: 22,
  dpi: 300,
};

/** Millimetres → pixels at `dpi`, rounded to integer. */
export function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm / 25.4) * dpi);
}

/** Clamp a pixel value into [minPx, maxPx]. */
export function clampPx(value: number, minPx: number, maxPx: number): number {
  return Math.max(minPx, Math.min(maxPx, value));
}

/** Scale (srcW, srcH) to fit inside (maxW, maxH) without cropping (CSS `contain`). */
export function containDimensions(
  srcW: number,
  srcH: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  const scale = Math.min(maxW / srcW, maxH / srcH);
  return { width: Math.round(srcW * scale), height: Math.round(srcH * scale) };
}

/**
 * Resolve the artwork + signature rectangles for one print-area canvas. The artwork
 * is `contain`-fit (always fully visible, never cropped), horizontally centred, with
 * the [artwork + gap + signature] block vertically centred inside the margin'd region.
 * `opticalOffset` nudges the artwork only — the signature stays canvas-centred.
 */
export function composeLayout(
  canvas: { width: number; height: number },
  artwork: { aspect: number },
  signature: { aspect: number },
  config: PrintCompositionConfig,
): ComposedGeometry {
  const { width: w, height: h } = canvas;
  const L = config.layout;
  const shortSide = Math.min(w, h);

  const marginPx = clampPx(
    shortSide * L.marginShortSideFrac,
    mmToPx(L.minMarginMm, L.dpi),
    mmToPx(L.maxMarginMm, L.dpi),
  );
  const sigH = clampPx(
    h * L.signatureHeightFrac,
    mmToPx(L.minSignatureMm, L.dpi),
    mmToPx(L.maxSignatureMm, L.dpi),
  );
  const sigGap = clampPx(
    h * L.signatureGapFrac,
    mmToPx(L.minSignatureGapMm, L.dpi),
    mmToPx(L.maxSignatureGapMm, L.dpi),
  );

  const availW = w - 2 * marginPx;
  const availH = h - 2 * marginPx - sigGap - sigH;
  if (availW <= 0 || availH <= 0) {
    throw new Error(`Composition margins leave no room for artwork at ${w}x${h} (margin=${marginPx}px)`);
  }

  const maxBoxW = Math.min(availW, w * L.artworkMaxWidthFrac);
  const maxBoxH = Math.min(availH, h * L.artworkMaxHeightFrac);
  const contained = containDimensions(artwork.aspect, 1, maxBoxW, maxBoxH);

  const blockH = contained.height + sigGap + sigH;
  const blockTop = marginPx + ((h - 2 * marginPx) - blockH) / 2;

  const sigW = Math.round(sigH * signature.aspect);

  // Optical offset nudges the artwork; clamp so it never leaves the canvas.
  const artW = Math.max(1, Math.min(contained.width, w));
  const artH = Math.max(1, Math.min(contained.height, h));
  const artLeft = Math.round(
    clampPx((w - artW) / 2 + config.opticalOffset.x * w, 0, w - artW),
  );
  const artTop = Math.round(clampPx(blockTop + config.opticalOffset.y * h, 0, h - artH));

  return {
    canvas: { width: w, height: h },
    artwork: { left: artLeft, top: artTop, width: artW, height: artH },
    signature: {
      left: Math.round((w - sigW) / 2),
      top: Math.round(blockTop + artH + sigGap),
      width: sigW,
      height: sigH,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/print-composition.test.ts`
Expected: PASS — all `mmToPx` / `clampPx` / `containDimensions` / `composeLayout` tests green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/print-composition.ts src/lib/print-composition.test.ts
git commit -m "feat(prints): add pure composition layout math

Deterministic per-profile geometry (contain-fit artwork, centred signature,
optical offset) from aspect-agnostic fractions. No Sharp — bundles safely
into the Workers runtime.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Config parser + defaults

**Files:**
- Modify: `src/lib/print-composition.ts` (append `parseCompositionConfig`)
- Test: `src/lib/print-composition.test.ts` (append a `describe`)

**Interfaces:**
- Produces: `parseCompositionConfig(raw, productId): PrintCompositionConfig`. Consumes `DEFAULT_LAYOUT`, `BACKGROUND_DEFAULT` from Task 1. Consumed by Task 4 (CLI).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/print-composition.test.ts` (add the import `parseCompositionConfig` to the existing import block, then this block):

```ts
import { parseCompositionConfig } from './print-composition';

describe('parseCompositionConfig', () => {
  const minimal = {
    product: 'fap01',
    artwork: 'design/prints/fap01-artwork.tif',
    signature: { src: 'config/print-composition/signature.svg' },
  };

  it('fills defaults for background, layout, and optical offset', () => {
    const cfg = parseCompositionConfig(minimal, 'fap01');
    expect(cfg.background).toBe('#ded9c3');
    expect(cfg.layout).toEqual(DEFAULT_LAYOUT);
    expect(cfg.opticalOffset).toEqual({ x: 0, y: 0 });
  });

  it('rejects a product id that does not match', () => {
    expect(() => parseCompositionConfig(minimal, 'fap02')).toThrow(/product/i);
  });

  it('rejects a missing artwork path', () => {
    expect(() => parseCompositionConfig({ ...minimal, artwork: '' }, 'fap01')).toThrow(/artwork/i);
  });

  it('rejects an invalid background hex', () => {
    expect(() => parseCompositionConfig({ ...minimal, background: 'pink' }, 'fap01')).toThrow(/background/i);
  });

  it('merges a partial layout over the defaults', () => {
    const cfg = parseCompositionConfig({ ...minimal, layout: { artworkMaxWidthFrac: 0.8 } }, 'fap01');
    expect(cfg.layout.artworkMaxWidthFrac).toBe(0.8);
    expect(cfg.layout.marginShortSideFrac).toBe(DEFAULT_LAYOUT.marginShortSideFrac);
  });

  it('rejects a layout fraction outside (0, 1]', () => {
    expect(() => parseCompositionConfig({ ...minimal, layout: { artworkMaxWidthFrac: 1.5 } }, 'fap01')).toThrow(/fraction/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/print-composition.test.ts`
Expected: FAIL — `parseCompositionConfig is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/print-composition.ts`:

```ts
// ── Config parsing ────────────────────────────────────────────────────────────

const HEX_RE = /^#?[0-9a-f]{6}$/i;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid print-composition config: ${message}`);
}

/**
 * Validate + normalise a raw config/print-composition/{productId}.json object.
 * `layout` and `background` are optional — they default to DEFAULT_LAYOUT /
 * #ded9c3 — so a per-product config can be as small as { product, artwork, signature }.
 */
export function parseCompositionConfig(
  raw: unknown,
  productId: string,
): PrintCompositionConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  assert(typeof r.product === 'string' && r.product === productId, `product must equal "${productId}"`);
  assert(typeof r.artwork === 'string' && r.artwork.length > 0, 'artwork must be a non-empty path');

  const background = typeof r.background === 'string' ? r.background : BACKGROUND_DEFAULT;
  assert(HEX_RE.test(background), `background "${background}" must be #rrggbb`);

  assert(
    r.signature && typeof r.signature === 'object' && typeof (r.signature as { src?: unknown }).src === 'string' &&
      ((r.signature as { src: string }).src.length > 0),
    'signature.src must be a non-empty path',
  );

  const rawLayout = (r.layout ?? {}) as Record<string, number>;
  const layout: CompositionLayout = { ...DEFAULT_LAYOUT };
  for (const key of Object.keys(rawLayout) as (keyof CompositionLayout)[]) {
    const value = rawLayout[key];
    assert(typeof value === 'number' && Number.isFinite(value), `layout.${key} must be a number`);
    if (key.endsWith('Frac')) {
      assert(value > 0 && value <= 1, `layout.${key} fraction must be in (0, 1]`);
    } else {
      assert(value > 0, `layout.${key} must be positive`);
    }
    (layout[key] as number) = value;
  }

  const rawOffset = (r.opticalOffset ?? {}) as { x?: number; y?: number };
  const x = rawOffset.x ?? 0;
  const y = rawOffset.y ?? 0;
  assert(typeof x === 'number' && Number.isFinite(x), 'opticalOffset.x must be a number');
  assert(typeof y === 'number' && Number.isFinite(y), 'opticalOffset.y must be a number');

  return {
    product: r.product,
    artwork: r.artwork,
    background: background.startsWith('#') ? background : `#${background}`,
    signature: { src: (r.signature as { src: string }).src },
    layout,
    opticalOffset: { x, y },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/print-composition.test.ts`
Expected: PASS — all geometry + parser tests green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/print-composition.ts src/lib/print-composition.test.ts
git commit -m "feat(prints): add composition config parser with defaults

Validates config/print-composition/{id}.json; layout + background default so a
per-product config can be { product, artwork, signature }.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Sharp composition module

**Files:**
- Create: `scripts/lib/compose-master.ts`
- Test: `scripts/lib/compose-master.test.ts`

**Interfaces:**
- Consumes: `composeLayout`, `PrintCompositionConfig` from `src/lib/print-composition`; `DerivativeResult`, `DerivativeFormat` from `src/lib/print-assets-prepare` (`scripts/lib/prepare-derivatives.ts` re-exports `DerivativeResult`).
- Produces: `composeDerivative(artworkPath, signaturePath, canvas, format, config): Promise<DerivativeResult>`. Consumed by Task 4 (CLI).

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/compose-master.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { composeDerivative } from './compose-master';
import { DEFAULT_LAYOUT, BACKGROUND_DEFAULT } from '../../src/lib/print-composition';

let tmpDir: string;
let artworkPng: string; // 700x1000 (7:10), opaque red
let signatureSvg: string; // 300x100 (3:1) viewBox

const config = {
  product: 'fap01',
  artwork: '',
  background: BACKGROUND_DEFAULT,
  signature: { src: '' },
  layout: DEFAULT_LAYOUT,
  opticalOffset: { x: 0, y: 0 },
};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-master-'));
  artworkPng = path.join(tmpDir, 'artwork.png');
  await sharp({ create: { width: 700, height: 1000, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .withMetadata({ icc: 'srgb' })
    .png()
    .toFile(artworkPng);
  config.artwork = artworkPng;
  signatureSvg = path.join(tmpDir, 'signature.svg');
  fs.writeFileSync(
    signatureSvg,
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100" viewBox="0 0 300 100"><rect width="300" height="100" fill="#222"/></svg>`,
  );
  config.signature.src = signatureSvg;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('composeDerivative', () => {
  it('decodes to exactly the requested canvas dimensions', async () => {
    const result = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(3600);
    expect(meta.height).toBe(4800);
  });

  it('produces a JPG with no alpha channel', async () => {
    const result = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.hasAlpha).toBe(false);
  });

  it('is deterministic — same inputs yield the same sha256', async () => {
    const a = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const b = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    expect(a.sha256).toBe(b.sha256);
  });

  it('produces a different sha256 for a different canvas size', async () => {
    const a = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const b = await composeDerivative(artworkPng, signatureSvg, { width: 8400, height: 12000 }, 'jpg', config);
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('honours the requested format', async () => {
    const jpg = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const png = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'png', config);
    expect(jpg.format).toBe('jpg');
    expect(png.format).toBe('png');
  });

  it('embeds an sRGB ICC profile', async () => {
    const result = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.icc).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/lib/compose-master.test.ts`
Expected: FAIL — `Cannot find module './compose-master'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/compose-master.ts`:

```ts
/**
 * Sharp composition for `scripts/print-assets-compose.ts`.
 *
 * The ONLY new module that touches Sharp for composition. Lives under scripts/lib/
 * (not src/lib/) — Sharp is a native binding incompatible with the Cloudflare
 * Workers runtime that src/lib/ bundles into (mirrors prepare-derivatives.ts).
 *
 * Pure geometry lives in src/lib/print-composition.ts and is resolved by this
 * module before Sharp runs.
 */
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
  composeLayout,
  type PrintCompositionConfig,
} from '../../src/lib/print-composition';
import type { DerivativeFormat } from '../../src/lib/print-assets-prepare';
import type { DerivativeResult } from './prepare-derivatives';

export interface ComposeCanvas {
  width: number;
  height: number;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid background colour "${hex}" — expected #rrggbb`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

async function resizedLayer(srcPath: string, width: number, height: number): Promise<Buffer> {
  return sharp(srcPath).resize(width, height, { fit: 'fill' }).toBuffer();
}

async function aspectOf(srcPath: string, label: string): Promise<number> {
  const meta = await sharp(srcPath).metadata();
  const aspect = (meta.width ?? 0) / (meta.height ?? 1);
  if (!aspect || !Number.isFinite(aspect)) {
    throw new Error(`Could not read ${label} dimensions from ${srcPath}${label === 'signature' ? ' (ensure the SVG has a viewBox)' : ''}`);
  }
  return aspect;
}

/**
 * Compose one exact-pixel print-area derivative: #ded9c3 (or configured) background
 * fill → artwork `contain`-fit (always fully visible) → centred signature. Deterministic
 * (fixed JPEG quality, no encoder jitter) and embeds the sRGB ICC profile so the file
 * Prodigi receives isn't unprofiled.
 */
export async function composeDerivative(
  artworkPath: string,
  signaturePath: string,
  canvas: ComposeCanvas,
  format: DerivativeFormat,
  config: PrintCompositionConfig,
): Promise<DerivativeResult> {
  const artAspect = await aspectOf(artworkPath, 'artwork');
  const sigAspect = await aspectOf(signaturePath, 'signature');

  const geo = composeLayout(canvas, { aspect: artAspect }, { aspect: sigAspect }, config);
  const background = parseHex(config.background);

  const artworkLayer = await resizedLayer(artworkPath, geo.artwork.width, geo.artwork.height);
  const signatureLayer = await resizedLayer(signaturePath, geo.signature.width, geo.signature.height);

  let pipeline = sharp({
    create: { width: canvas.width, height: canvas.height, channels: 3, background },
  })
    .composite([
      { input: artworkLayer, left: geo.artwork.left, top: geo.artwork.top },
      { input: signatureLayer, left: geo.signature.left, top: geo.signature.top },
    ])
    .withMetadata({ icc: 'srgb' }); // embed sRGB so the file isn't unprofiled

  // The base canvas is opaque (channels:3); flatten is a no-op safety net matching
  // prepare-derivatives so a stray alpha never reaches a JPG bound for Prodigi.
  if (format === 'jpg') {
    pipeline = pipeline
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: false });
  }

  const buffer = await pipeline.toBuffer();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { sha256, byteSize: buffer.byteLength, format, buffer };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/lib/compose-master.test.ts`
Expected: PASS — all six `composeDerivative` tests green (dimensions, no alpha, determinism, size-dependence, format, ICC).

- [ ] **Step 5: Typecheck + full unit suite**

Run: `npm run typecheck && npm run test`
Expected: no type errors; all tests pass (including the existing `prepare-derivatives.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/compose-master.ts scripts/lib/compose-master.test.ts
git commit -m "feat(prints): add Sharp composition module (per-profile)

Composes artwork (contain) + #ded9c3 background + centred SVG signature at
exact Prodigi print-area pixels. Deterministic, sRGB-embedded. Mirrors
prepare-derivatives encoding.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Operator CLI

**Files:**
- Create: `scripts/print-assets-compose.ts`
- Modify: `package.json` (add the script)

**Interfaces:**
- Consumes: `parseCompositionConfig`, `PrintCompositionConfig` (Task 2); `composeDerivative` (Task 3); `buildManifest`, `distinctProfiles`, `refuseOverwrite`, `DerivativeFormat` (`src/lib/print-assets-prepare`); `activeVariantDimensions` (`scripts/lib/db-variants`); `prepareOutputDir`, `writeDerivative`, `DerivativeResult` (`scripts/lib/prepare-derivatives`); `loadSupabaseClient` (`scripts/lib/script-env`); `getArg`, `hasFlag`, `revisionDir`, `ROOT` (`scripts/lib/print-assets-cli`).
- Produces: `npm run print-assets:compose -- --product <id> --revision <rev> [--force] [--dry-run]`, writing a prepare-compatible `manifest.json` + derivatives + proofs under `design/print-assets/{id}/{rev}/`.

- [ ] **Step 1: Write the CLI**

Create `scripts/print-assets-compose.ts`:

```ts
/**
 * Compose deterministic Prodigi print-area derivatives from layered inputs
 * (artwork + background + signature) — a sibling to print-assets-prepare that
 * REPLACES per-size hand-cropping with parametric per-profile composition
 * (docs/superpowers/specs/2026-07-15-print-composition-engine-design.md).
 *
 * Enumerates active DB variants → dedupes to distinct profiles → composes each
 * profile's exact-pixel canvas → writes a manifest.json that the EXISTING
 * print-assets:upload/verify/publish consume unchanged (those scripts read only
 * the manifest + named files; they do not care how the pixels were made).
 *
 * Usage:
 *   npm run print-assets:compose -- --product fap01 --revision 2026-07-15-r1
 *   npm run print-assets:compose -- --product fap01 --revision 2026-07-15-r1 --force
 *   npm run print-assets:compose -- --product fap01 --revision 2026-07-15-r1 --dry-run
 *
 * Output (gitignored): design/print-assets/{productId}/{revision}/
 *   - {w}x{h}-{sha256}.{jpg|png} per distinct profile
 *   - manifest.json (the Phase 2b contract)
 *   - proof-{w}x{h}.jpg — 600px review proof, never uploaded
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and a seeded product_variants
 * table (npm run catalog:backfill). Read-only on R2 and the DB (upload/publish
 * are separate scripts).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
  buildManifest,
  distinctProfiles,
  refuseOverwrite,
  type DerivativeFormat,
} from '../src/lib/print-assets-prepare';
import { parseCompositionConfig, type PrintCompositionConfig } from '../src/lib/print-composition';
import { composeDerivative } from './lib/compose-master';
import { prepareOutputDir, writeDerivative } from './lib/prepare-derivatives';
import { activeVariantDimensions } from './lib/db-variants';
import { loadSupabaseClient } from './lib/script-env';
import { getArg, hasFlag, revisionDir, ROOT } from './lib/print-assets-cli';

/** Load + validate config/print-composition/{productId}.json. Fails loudly if missing/malformed. */
function loadCompositionConfig(productId: string): PrintCompositionConfig {
  const configPath = path.join(ROOT, 'config', 'print-composition', `${productId}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No composition config for product "${productId}" — expected ${path.relative(ROOT, configPath)}.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return parseCompositionConfig(raw, productId);
}

async function main(): Promise<void> {
  const productId = getArg('product');
  const revision = getArg('revision');
  const force = hasFlag('force');
  const dryRun = hasFlag('dry-run');

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');
  if (!revision) throw new Error('Missing --revision (e.g. --revision 2026-07-15-r1)');

  const config = loadCompositionConfig(productId);
  const artworkPath = path.resolve(ROOT, config.artwork);
  const signaturePath = path.resolve(ROOT, config.signature.src);
  if (!fs.existsSync(artworkPath)) throw new Error(`Artwork master not found: ${artworkPath}`);
  if (!fs.existsSync(signaturePath)) throw new Error(`Signature not found: ${signaturePath}`);

  console.log(`print-assets:compose — product=${productId} revision=${revision}`);

  const supabase = loadSupabaseClient();
  const variantDims = await activeVariantDimensions(supabase, productId);
  const profiles = distinctProfiles(variantDims);
  console.log(
    `  ${variantDims.length} active variant(s) → ${profiles.length} distinct profile(s): ` +
      `${profiles.map((p) => p.profileKey).join(', ')}`,
  );

  // Output format mirrors the existing pipeline (fap01 uses jpg). Per-config format
  // is a later knob if a design ever needs PNG; jpg is correct for opaque prints.
  const format: DerivativeFormat = 'jpg';

  const sourceMeta = await sharp(artworkPath).metadata();
  const sourceSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(artworkPath))
    .digest('hex');
  console.log(
    `  artwork: ${sourceMeta.width}x${sourceMeta.height}  sha256: ${sourceSha256.slice(0, 12)}…`,
  );

  const outputDir = revisionDir(productId, revision);
  refuseOverwrite(outputDir, { exists: () => fs.existsSync(outputDir), force });

  if (dryRun) {
    console.log(
      `\nDRY RUN — would compose ${profiles.length} derivative(s) + manifest into ${path.relative(ROOT, outputDir)}/`,
    );
    return;
  }

  const derivativeMeta: Record<string, { sha256: string; byteSize: number; format: DerivativeFormat }> = {};
  prepareOutputDir(outputDir, { force });

  for (const profile of profiles) {
    process.stdout.write(`  composing ${profile.profileKey}.${format} … `);
    const result = await composeDerivative(
      artworkPath,
      signaturePath,
      { width: profile.w, height: profile.h },
      format,
      config,
    );
    const filename = `${profile.profileKey}-${result.sha256}.${format}`;
    writeDerivative(path.join(outputDir, filename), result.buffer);
    derivativeMeta[profile.profileKey] = { sha256: result.sha256, byteSize: result.byteSize, format: result.format };

    // Review proof — small, visual-only, never uploaded (the manifest never lists it).
    await sharp(result.buffer)
      .resize({ width: 600 })
      .jpeg({ quality: 70 })
      .toFile(path.join(outputDir, `proof-${profile.profileKey}.jpg`));

    console.log(`${(result.byteSize / 1024).toFixed(0)} KB → ${filename}`);
  }

  const manifest = buildManifest({
    product: productId,
    revision,
    sourceSha256,
    sourceWidth: sourceMeta.width ?? 0,
    sourceHeight: sourceMeta.height ?? 0,
    profiles,
    derivativeMeta,
  });
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(
    `\nDone. ${profiles.length} composed derivative(s) + manifest written to ${path.relative(ROOT, outputDir)}/`,
  );
  console.log('Review proof-*.jpg, then: npm run print-assets:upload → verify → publish.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 2: Wire the npm script**

In `package.json`, add this line immediately after the existing `"print-assets:prepare"` entry (inside `"scripts"`):

```json
    "print-assets:compose": "tsx scripts/print-assets-compose.ts",
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (The CLI is orchestration; like `print-assets-prepare.ts` it has no unit test — its functional verification is the end-to-end run in Task 5.)

- [ ] **Step 4: Commit**

```bash
git add scripts/print-assets-compose.ts package.json
git commit -m "feat(prints): add print-assets:compose CLI

Mirrors print-assets-prepare: enumerate active variants → dedupe profiles →
compose each → write a prepare-compatible manifest. Downstream upload/verify/
publish run unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Config assets + end-to-end verification

**Files:**
- Create: `config/print-composition/signature.svg`
- Create: `config/print-composition/fap01.json`
- Create: `config/print-composition/README.md`

**Interfaces:**
- Consumes: the CLI from Task 4. Produces: the tracked inputs the operator edits per design.

- [ ] **Step 1: Add the shared signature placeholder**

Create `config/print-composition/signature.svg`. This is a **placeholder** the studio replaces with Anna's real signature; it must have a `viewBox` so Sharp can read its aspect ratio:

```xml
<!--
  Placeholder signature — REPLACE with Anna Ciok's real signature (vector).
  Kept under tracked config/ (not gitignored design/) because it is a small,
  stable brand asset shared by every print. Must keep a viewBox so the composer
  can read its aspect ratio. See docs/superpowers/specs/2026-07-15-print-composition-engine-design.md.
-->
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200">
  <rect width="600" height="200" fill="none"/>
  <text x="300" y="135" text-anchor="middle" font-family="Georgia, serif" font-size="120" fill="#3a3a3a">ANNA CIOK</text>
</svg>
```

- [ ] **Step 2: Add the fap01 composition config**

Create `config/print-composition/fap01.json`. Layout + background default, so only the artwork path + signature ref + a starting optical offset are needed:

```json
{
  "_comment": "Composition config for fap01. background (#ded9c3) and layout default from src/lib/print-composition.ts; override layout here only if this design needs different margins/signature scale. opticalOffset tunes optical centering (fractions of canvas); tune per artwork after reviewing proof-*.jpg. Artwork path is gitignored (design/ tree).",
  "product": "fap01",
  "artwork": "design/prints/fap01-artwork.tif",
  "signature": { "src": "config/print-composition/signature.svg" },
  "opticalOffset": { "x": 0, "y": 0 }
}
```

- [ ] **Step 3: Document the workflow**

Create `config/print-composition/README.md`:

```markdown
# Print composition configs

One file per print product: `config/print-composition/{productId}.json`, plus the
shared `signature.svg`. Consumed by `npm run print-assets:compose`
(see `docs/superpowers/specs/2026-07-15-print-composition-engine-design.md`).

## Schema

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `product` | yes | — | Must match the `--product` id. |
| `artwork` | yes | — | Path to the artwork master (gitignored `design/` tree), repo-relative. |
| `signature.src` | yes | — | Shared SVG, repo-relative. Defaults to `config/print-composition/signature.svg`. |
| `background` | no | `#ded9c3` | `#rrggbb` canvas fill. |
| `layout` | no | see `DEFAULT_LAYOUT` | Override any subset of the fractions / mm clamps / dpi. |
| `opticalOffset` | no | `{x:0,y:0}` | Per-artwork centering nudge, fractions of canvas. |

Layout defaults live in `src/lib/print-composition.ts` (`DEFAULT_LAYOUT`): 6.5% margin
(clamped 18–55 mm), artwork ≤85% width / ≤76% height, signature 2.8% height (8–20 mm),
2.2% gap (8–22 mm), 300 DPI. Tune `opticalOffset` after reviewing the `proof-*.jpg`.

## Workflow

1. Drop the artwork master at the configured `artwork` path (gitignored `design/`).
2. `npm run print-assets:compose -- --product <id> --revision <YYYY-MM-DD-rN>`.
3. Open every `design/print-assets/<id>/<rev>/proof-*.jpg`; tune `opticalOffset` /
   `layout` and re-run until the composition is right.
4. `npm run print-assets:upload → verify → publish` (unchanged pipeline).
5. `npm run print-assets:sandbox-matrix -- --product <id>` for a physical Prodigi
   sandbox order per profile — the real fidelity gate.
```

- [ ] **Step 4: End-to-end smoke (operator, needs artwork + seeded DB)**

With a real artwork master at `design/prints/fap01-artwork.tif` and `product_variants` seeded (`npm run catalog:backfill`), run:

```bash
npm run print-assets:compose -- --product fap01 --revision 2026-07-15-r1
```

Expected: logs `N active variant(s) → M distinct profile(s)` (M ≈ 7 for fap01), one `composing <profile>.jpg … <KB> KB → <file>` line per profile, then `Done. M composed derivative(s) + manifest written`. Inspect `design/print-assets/fap01/2026-07-15-r1/proof-*.jpg` — artwork fully visible (contain), signature centred below, `#ded9c3` margins. (If no artwork/DB is available in this environment, this step is deferred to the operator; the automated gates below still run.)

- [ ] **Step 5: Run the repo gates**

Run: `npm run typecheck && npm run test && npm run lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add config/print-composition/
git commit -m "docs(prints): add composition config assets (signature, fap01, readme)

Shared placeholder signature.svg (replace with Anna's real signature) + fap01
layout config + schema/workflow docs.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Verification (whole feature)

- **Unit:** `npm run test` — pure geometry (`src/lib/print-composition.test.ts`), config parser (same file), and Sharp composition (`scripts/lib/compose-master.test.ts`) all green and deterministic.
- **Types/Lint:** `npm run typecheck && npm run lint` clean.
- **End-to-end on one design (Task 5 Step 4):** `print-assets:compose` → inspect `proof-*.jpg` → `print-assets:upload` → `verify` → `publish` → `print-assets:sandbox-matrix` (a real Prodigi sandbox order per profile — the physical fidelity gate that matches the quality goal).
- **Downstream unchanged:** confirm `print-assets:upload/verify/publish` consume the composed `manifest.json` with no code change (they read only the manifest + named files).

## Out of scope (Phase 2, if the JSON-tune loop proves painful)

Interactive admin UI (live canvas preview + scale/X/Y sliders + browser upload + an `/api/admin/compose/*` R2-write route). Build on `useAdminAction` / `.adm-detail-layout`; see spec §Phase 2. Consider a local dev-only preview page before the gated production admin.
