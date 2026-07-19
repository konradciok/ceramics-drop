# Print Configurator Live Mockup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a buyer changes framed / frame colour / passe-partout in `PrintConfigurator`, the PDP hero swaps to a pre-rendered photorealistic mockup of that configuration (spec: `docs/superpowers/specs/2026-07-19-print-configurator-live-mockup-design.md`).

**Architecture:** A pure state-mapping lib (`print-mockups.ts`) + one new client wrapper that lifts the configurator's `sel` state and feeds the existing dumb gallery a computed hero src. Mockup WebPs are pre-rendered by a new pipeline step (`print-assets:mockups`) that composites published fulfilment derivatives (FAP sheet for framed, CFPM aperture for mount — physically accurate) into shared frame masters with sharp. Feature is gated per design by a `mockups?: true` registry flag; without it the PDP is byte-identical to today.

**Tech Stack:** Next.js 16 App Router (server components + client islands), sharp (already a dependency), Vitest, Playwright, existing print-assets CLI helpers (`scripts/lib/*`), R2 via wrangler.

## Global Constraints

- Build stays `next build --webpack` — never Turbopack, never `--turbo`.
- Product imagery uses native `<img>` + `srcSet()` from `src/lib/images.ts` — never `next/image`.
- Server components by default; `'use client'` only where state/hooks exist.
- No new npm dependencies.
- Presentation-only: cart tokens, pricing, checkout validation, `PRODIGI_SKU_MAP`, fulfilment paths are untouched.
- No new i18n strings (`variantLabel` from `src/lib/print-cart.ts` is reused for alt text); if copy is ever added it must land in all of `messages/{pl,en,es,de}.json`.
- Designs without `mockups: true` must render byte-identical to today (feature is purely additive).
- Canonical mockup ratio is 7:10 (`width/height = 0.7`); framed states composite the `8400x12000` FAP profile, mount states the `7200x10800` CFPM profile.
- Monetary rules, analytics event contract, and locale routing are out of scope and must not change.

## File Map

| File | Role |
|---|---|
| `src/lib/print-mockups.ts` (create) | Pure state model: `MockupState`, `mockupState`, `mockupSrc`, `mockupHeroSrc`, `designMockupStates` |
| `src/lib/print-mockups.test.ts` (create) | Truth-table tests for the above |
| `src/lib/types.ts` (modify) | `mockups?: true` on `PrintDesign` |
| `src/components/shop/ProductPageGallery.tsx` (modify) | Optional `syncKey` prop → reset to slide 0 |
| `src/components/shop/PrintPdpPurchase.tsx` (create) | Client wrapper owning `sel`; renders gallery + configurator |
| `src/components/shop/PrintConfigurator.tsx` (modify) | Becomes controlled (`sel` + `onSelChange` props) |
| `src/components/shop/PrintProductScreen.tsx` (modify) | Renders the wrapper with header/footer slots |
| `src/lib/print-mockups-compose.ts` (create) | `composeMockup()` — sharp composition core |
| `src/lib/print-mockups-compose.test.ts` (create) | Synthetic-fixture composition tests |
| `scripts/lib/print-assets-storefront.ts` (create) | `resolveSourcePath` + `generateWebpSet` extracted from the gallery script |
| `scripts/print-assets-gallery.ts` (modify) | Import the extracted helpers |
| `scripts/print-assets-mockups.ts` (create) | CLI: compose + upload + mirror mockup WebPs |
| `config/print-assets/frames.example.json` (create) | Frame-master registry template |
| `package.json` (modify) | `print-assets:mockups` script |
| `docs/print-asset-runbook.md` (modify) | Operator procedure for the mockup step |
| `AGENTS.md` (modify) | Command list mention |
| `e2e/print-configurator.spec.ts` (modify) | Hero-swap E2E (skip-guarded) + static-hero regression |

Execution branch: continue on `docs/print-configurator-live-mockup-spec` or a fresh `feat/print-live-mockup` branched from it. Do not touch the pre-existing dirty files `config/print-assets/fap0*.json` — they belong to a parallel revision effort.

---

### Task 1: Pure mockup state lib + registry flag

**Files:**
- Create: `src/lib/print-mockups.ts`
- Create: `src/lib/print-mockups.test.ts`
- Modify: `src/lib/types.ts` (PrintDesign interface, after `prices?` field, ~line 113)

**Interfaces:**
- Consumes: `PrintDesign`, `PrintVariantSelection`, `PrintFrameColour` from `src/lib/types.ts`.
- Produces (later tasks rely on these exact names):
  - `type MockupState = 'plain' | \`framed-${PrintFrameColour}\` | \`mount-${PrintFrameColour}\``
  - `mockupState(sel: PrintVariantSelection): MockupState`
  - `mockupSrc(design: PrintDesign, state: MockupState): string | undefined`
  - `mockupHeroSrc(design: PrintDesign, sel: PrintVariantSelection): string`
  - `designMockupStates(design: PrintDesign): MockupState[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/print-mockups.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  designMockupStates,
  mockupHeroSrc,
  mockupSrc,
  mockupState,
} from './print-mockups';
import type { PrintDesign, PrintVariantSelection } from './types';

const design: PrintDesign = {
  id: 'fap01',
  category: 'fine-art-prints',
  num: '01',
  image: '/uploads/fap-01.webp',
  noteIndex: 0,
  sizes: ['30x40', '50x70', '70x100'],
  frameColours: ['black', 'white', 'natural'],
  mountAvailable: true,
  published: true,
};

const flagged: PrintDesign = { ...design, mockups: true };

function sel(over: Partial<PrintVariantSelection>): PrintVariantSelection {
  return { size: '30x40', framed: false, mount: false, frameColour: 'none', ...over };
}

describe('mockupState', () => {
  it('maps the full 7-state truth table', () => {
    expect(mockupState(sel({}))).toBe('plain');
    expect(mockupState(sel({ framed: true, frameColour: 'black' }))).toBe('framed-black');
    expect(mockupState(sel({ framed: true, frameColour: 'white' }))).toBe('framed-white');
    expect(mockupState(sel({ framed: true, frameColour: 'natural' }))).toBe('framed-natural');
    expect(mockupState(sel({ framed: true, mount: true, frameColour: 'black' }))).toBe('mount-black');
    expect(mockupState(sel({ framed: true, mount: true, frameColour: 'white' }))).toBe('mount-white');
    expect(mockupState(sel({ framed: true, mount: true, frameColour: 'natural' }))).toBe('mount-natural');
  });

  it('is size-independent', () => {
    expect(mockupState(sel({ size: '70x100', framed: true, frameColour: 'black' }))).toBe('framed-black');
  });

  it('degrades impossible combos to plain (total function)', () => {
    // decodePrintToken forbids framed+none, but the mapper must stay total.
    expect(mockupState(sel({ framed: true, frameColour: 'none' }))).toBe('plain');
  });
});

describe('mockupSrc', () => {
  it('builds the path from the design image stem', () => {
    expect(mockupSrc(flagged, 'framed-black')).toBe('/uploads/fap-01-mock-framed-black.webp');
    expect(mockupSrc(flagged, 'mount-natural')).toBe('/uploads/fap-01-mock-mount-natural.webp');
  });

  it('returns undefined for plain and for designs without the flag', () => {
    expect(mockupSrc(flagged, 'plain')).toBeUndefined();
    expect(mockupSrc(design, 'framed-black')).toBeUndefined();
  });
});

describe('mockupHeroSrc', () => {
  it('returns the mockup for flagged designs and the base image otherwise', () => {
    expect(mockupHeroSrc(flagged, sel({ framed: true, frameColour: 'white' }))).toBe(
      '/uploads/fap-01-mock-framed-white.webp',
    );
    expect(mockupHeroSrc(flagged, sel({}))).toBe('/uploads/fap-01.webp');
    expect(mockupHeroSrc(design, sel({ framed: true, frameColour: 'white' }))).toBe('/uploads/fap-01.webp');
  });
});

describe('designMockupStates', () => {
  it('enumerates framed+mount states for full-axis designs (no plain)', () => {
    expect(designMockupStates(design)).toEqual([
      'framed-black', 'mount-black',
      'framed-white', 'mount-white',
      'framed-natural', 'mount-natural',
    ]);
  });

  it('respects narrower axes (fap02 shape: 2 colours, no mount)', () => {
    const narrow: PrintDesign = { ...design, frameColours: ['black', 'white'], mountAvailable: false };
    expect(designMockupStates(narrow)).toEqual(['framed-black', 'framed-white']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/print-mockups.test.ts`
Expected: FAIL — `Cannot find module './print-mockups'` (and a TS error on `mockups: true` until types.ts is edited).

- [ ] **Step 3: Add the registry flag to `PrintDesign`**

In `src/lib/types.ts`, inside `interface PrintDesign` directly after the `prices?` field:

```ts
  /** Set when pre-rendered configurator mockups exist in public/uploads
      (<image-stem>-mock-{framed|mount}-{colour}.webp). Ship the flag in the
      same PR as the generated files (print-assets:mockups). */
  mockups?: true;
```

- [ ] **Step 4: Write minimal implementation**

Create `src/lib/print-mockups.ts`:

```ts
import type { PrintDesign, PrintFrameColour, PrintVariantSelection } from './types';

/* ------------------------------------------------------------------
   Live-mockup visual state model (spec:
   docs/superpowers/specs/2026-07-19-print-configurator-live-mockup-design.md).
   Pure functions — the PDP hero swap has no DOM test harness, so all
   decision logic lives here, unit-tested (same pattern as
   printVariantButtonState in print-cart.ts). Size is deliberately NOT part
   of the state: one canonical 7:10 mockup per visual state.
   ------------------------------------------------------------------ */

export type MockupState = 'plain' | `framed-${PrintFrameColour}` | `mount-${PrintFrameColour}`;

/** Selection → visual state. Total: impossible combos degrade to 'plain'. */
export function mockupState(sel: PrintVariantSelection): MockupState {
  if (!sel.framed || sel.frameColour === 'none') return 'plain';
  return sel.mount ? `mount-${sel.frameColour}` : `framed-${sel.frameColour}`;
}

/**
 * Public path of a pre-rendered mockup, derived from the design's image stem
 * ('/uploads/fap-01.webp' → '/uploads/fap-01-mock-framed-black.webp').
 * undefined for 'plain' (caller shows design.image) and for designs without
 * the `mockups` flag (feature off — hero stays static).
 */
export function mockupSrc(design: PrintDesign, state: MockupState): string | undefined {
  if (state === 'plain' || !design.mockups) return undefined;
  const dot = design.image.lastIndexOf('.');
  return `${design.image.slice(0, dot)}-mock-${state}${design.image.slice(dot)}`;
}

/** Hero src for the current selection, falling back to the base image. */
export function mockupHeroSrc(design: PrintDesign, sel: PrintVariantSelection): string {
  return mockupSrc(design, mockupState(sel)) ?? design.image;
}

/**
 * Every mockup state the design's axes can reach ('plain' excluded — it has
 * no dedicated asset). Intentionally ignores the `mockups` flag: the pipeline
 * enumerates states BEFORE the flag ships. Also used to prefetch.
 */
export function designMockupStates(design: PrintDesign): MockupState[] {
  const states: MockupState[] = [];
  for (const colour of design.frameColours) {
    states.push(`framed-${colour}`);
    if (design.mountAvailable) states.push(`mount-${colour}`);
  }
  return states;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/print-mockups.test.ts`
Expected: PASS (all suites). Then `npm run typecheck` — expected clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/print-mockups.ts src/lib/print-mockups.test.ts src/lib/types.ts
git commit -m "feat(prints): mockup visual-state model + PrintDesign.mockups flag"
```

---

### Task 2: Client wiring — wrapper, controlled configurator, gallery syncKey

**Files:**
- Create: `src/components/shop/PrintPdpPurchase.tsx`
- Modify: `src/components/shop/ProductPageGallery.tsx`
- Modify: `src/components/shop/PrintConfigurator.tsx`
- Modify: `src/components/shop/PrintProductScreen.tsx:62-93`

**Interfaces:**
- Consumes: `mockupHeroSrc`, `mockupSrc`, `designMockupStates` from Task 1; `variantLabel` from `src/lib/print-cart.ts`.
- Produces:
  - `PrintPdpPurchase({ design, images, alt, usableVariantKeys?, header, footer }: { design: PrintDesign; images: string[]; alt: string; usableVariantKeys?: string[]; header: React.ReactNode; footer: React.ReactNode })` — client component rendering `<ProductPageGallery>` + `<div className="pdp-body">{header}<PrintConfigurator …/>{footer}</div>`.
  - `PrintConfigurator` new signature: `{ design: PrintDesign; usableVariantKeys?: string[]; sel: PrintVariantSelection; onSelChange: (sel: PrintVariantSelection) => void }` (controlled; no internal `useState`).
  - `ProductPageGallery` new optional prop `syncKey?: string` — index resets to 0 whenever it changes.

There is no DOM render harness in this repo (documented in `PrintConfigurator.tsx:51-53`), so this task is verified by typecheck + lint + the existing `@ci` Playwright specs (which must stay green — the feature is a no-op while no design has `mockups: true`). New E2E coverage lands in Task 5.

- [ ] **Step 1: Add `syncKey` to `ProductPageGallery`**

In `src/components/shop/ProductPageGallery.tsx`, change the import, `Props`, and add one effect:

```tsx
import { useEffect, useState } from 'react';
```

```tsx
type Props = {
  images: string[];
  alt: string;
  /** When this changes, the gallery snaps back to slide 0 (the configurator
      hero) so a variant change is visible from any slide. */
  syncKey?: string;
};
```

```tsx
export function ProductPageGallery({ images, alt, syncKey }: Props) {
  const t = useTranslations();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
  }, [syncKey]);
  const current = images[index] ?? images[0];
```

Everything else in the file stays unchanged.

- [ ] **Step 2: Make `PrintConfigurator` controlled**

In `src/components/shop/PrintConfigurator.tsx`:

1. Remove the `useState` import (line 8: `import { useState } from 'react';` — delete the line; no other react import is needed).
2. Replace the component signature (lines 21-27) with:

```tsx
export function PrintConfigurator({
  design,
  usableVariantKeys,
  sel,
  onSelChange,
}: {
  design: PrintDesign;
  usableVariantKeys?: string[];
  sel: PrintVariantSelection;
  onSelChange: (sel: PrintVariantSelection) => void;
}) {
```

3. Delete the internal state block (lines 36-41):

```tsx
  const [sel, setSel] = useState<PrintVariantSelection>({
    size: design.sizes[0],
    framed: false,
    mount: false,
    frameColour: 'none',
  });
```

4. Replace `setFramed` (lines 61-68) with:

```tsx
  function setFramed(framed: boolean) {
    onSelChange({
      ...sel,
      framed,
      mount: false,
      frameColour: framed ? (design.frameColours[0] ?? 'black') : 'none',
    });
  }
```

5. Replace the three inline `setSel` call sites:
   - size button (line 84): `onClick={() => onSelChange({ ...sel, size })}`
   - colour button (line 135): `onClick={() => onSelChange({ ...sel, frameColour: colour as PrintFrameColour })}`
   - mount buttons (lines 155 and 165): `onClick={() => onSelChange({ ...sel, mount: false })}` and `onClick={() => onSelChange({ ...sel, mount: true })}`

Nothing else changes — pricing, `printVariantButtonState`, cart add/remove, and the analytics event keep working off the `sel` prop. `PrintConfigurator` has exactly one call site (`PrintProductScreen.tsx:72`), updated in Step 3.

- [ ] **Step 3: Create the wrapper**

Create `src/components/shop/PrintPdpPurchase.tsx`:

```tsx
'use client';

/* ============================================================
   PrintPdpPurchase — client shell that makes the PDP hero follow the
   configurator (TPC-style live mockup). Owns the variant selection and
   renders the gallery + configurator; the server-rendered heading and spec
   blocks flow through as ReactNode slots. For designs without the
   `mockups` flag the hero src never changes — byte-identical to the old
   sibling-islands layout.
   ============================================================ */
import { useEffect, useState, type ReactNode } from 'react';
import { useLocale } from 'next-intl';
import { ProductPageGallery } from './ProductPageGallery';
import { PrintConfigurator } from './PrintConfigurator';
import { designMockupStates, mockupHeroSrc, mockupSrc } from '@/lib/print-mockups';
import { variantLabel } from '@/lib/print-cart';
import type { PrintDesign, PrintVariantSelection } from '@/lib/types';

export function PrintPdpPurchase({
  design,
  images,
  alt,
  usableVariantKeys,
  header,
  footer,
}: {
  design: PrintDesign;
  images: string[];
  alt: string;
  usableVariantKeys?: string[];
  header: ReactNode;
  footer: ReactNode;
}) {
  const locale = useLocale();
  const [sel, setSel] = useState<PrintVariantSelection>({
    size: design.sizes[0],
    framed: false,
    mount: false,
    frameColour: 'none',
  });

  const heroSrc = mockupHeroSrc(design, sel);
  const heroImages = [heroSrc, ...images.slice(1)];

  // Warm the (≤6) mockup variants once so swaps render without flicker.
  useEffect(() => {
    if (!design.mockups) return;
    for (const state of designMockupStates(design)) {
      const src = mockupSrc(design, state);
      if (src) new Image().src = src;
    }
  }, [design]);

  return (
    <>
      <ProductPageGallery
        images={heroImages}
        alt={`${alt} — ${variantLabel(sel, locale)}`}
        syncKey={heroSrc}
      />
      <div className="pdp-body">
        {header}
        <PrintConfigurator
          design={design}
          usableVariantKeys={usableVariantKeys}
          sel={sel}
          onSelChange={setSel}
        />
        {footer}
      </div>
    </>
  );
}
```

Note: `syncKey={heroSrc}` means the gallery only snaps to slide 0 when the visual state actually changes (size clicks on an unframed print don't jump — `heroSrc` stays `design.image`).

- [ ] **Step 4: Rewire `PrintProductScreen`**

In `src/components/shop/PrintProductScreen.tsx`: replace the `ProductPageGallery` import (line 16) with `PrintPdpPurchase`:

```tsx
import { PrintPdpPurchase } from './PrintPdpPurchase';
import { PrintConfigurator } from './PrintConfigurator'; // ← DELETE this line (line 17)
```

(The screen no longer imports `ProductPageGallery` or `PrintConfigurator` directly.)

Replace the `.pdp-layout` block (lines 62-93) with:

```tsx
        <div className="pdp-layout">
          <PrintPdpPurchase
            design={design}
            images={images}
            alt={displayName}
            usableVariantKeys={usableVariantKeys}
            header={
              <>
                <div className="eyebrow">{categoryName}</div>
                <h1>
                  {singular} <em>Nº {design.num}</em>
                </h1>
                {note && <p className="pdp-note">{note}</p>}
              </>
            }
            footer={
              <div className="lb-specs print-specs">
                <div className="lb-spec">
                  <span className="k">{t('print.sectionDetails')}</span>
                  <span className="v">{t('print.technique')}<br />{sizeLines}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('print.sectionEdition')}</span>
                  <span className="v">{t('print.editionOpen')}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('print.sectionDelivery')}</span>
                  <span className="v">{t('print.deliveryNote')}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('print.sectionCare')}</span>
                  <span className="v">{t('print.careNote')}</span>
                </div>
              </div>
            }
          />
        </div>
```

The rendered DOM is unchanged: `.pdp-layout` still contains `[.pdp-images, .pdp-body]`, so no CSS changes.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all clean/passing (no behaviour change yet — no design has the flag).

Run: `npx playwright test e2e/print-configurator.spec.ts e2e/print-purchase.spec.ts`
Expected: PASS — the configurator behaves identically with lifted state (existing specs cover size/frame/colour/mount clicks, price, add-to-cart).

- [ ] **Step 6: Commit**

```bash
git add src/components/shop/PrintPdpPurchase.tsx src/components/shop/ProductPageGallery.tsx src/components/shop/PrintConfigurator.tsx src/components/shop/PrintProductScreen.tsx
git commit -m "feat(prints): configurator-driven hero via PrintPdpPurchase client shell"
```

---

### Task 3: Composition core (`composeMockup`)

**Files:**
- Create: `src/lib/print-mockups-compose.ts`
- Create: `src/lib/print-mockups-compose.test.ts`

**Interfaces:**
- Consumes: nothing project-specific (sharp + Buffers).
- Produces:
  - `interface MockupWindow { left: number; top: number; width: number; height: number }` (fractions of the frame canvas)
  - `composeMockup(opts: { sheet: Buffer; frame: Buffer; window: MockupWindow; outWidth?: number; background?: string }): Promise<Buffer>` — PNG buffer at `outWidth × round(outWidth/0.7)`; throws on frame-canvas or window/sheet ratio mismatch.
  - `const MOCKUP_RATIO = 0.7`, `const MOCKUP_RATIO_TOLERANCE = 0.02`, `const MOCKUP_DEFAULT_BACKGROUND = '#F1EFEA'`

This module lives in `src/lib/` (not `scripts/`) so Vitest covers it the same way it covers `print-assets-prepare.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/print-mockups-compose.test.ts`:

```ts
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { composeMockup, MOCKUP_DEFAULT_BACKGROUND } from './print-mockups-compose';

const WINDOW = { left: 0.15, top: 0.15, width: 0.7, height: 0.7 };

/** Opaque dark 700×1000 frame with a transparent window punched out. */
async function syntheticFrame(): Promise<Buffer> {
  const hole = await sharp({
    create: {
      width: Math.round(700 * WINDOW.width),
      height: Math.round(1000 * WINDOW.height),
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 700, height: 1000, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } },
  })
    .composite([
      {
        input: hole,
        left: Math.round(700 * WINDOW.left),
        top: Math.round(1000 * WINDOW.top),
        blend: 'dest-out',
      },
    ])
    .png()
    .toBuffer();
}

/** Solid red sheet at the FAP 7:10 ratio (matches the window ratio 490/700 = 0.7). */
async function syntheticSheet(): Promise<Buffer> {
  return sharp({
    create: { width: 350, height: 500, channels: 3, background: { r: 220, g: 30, b: 30 } },
  })
    .jpeg()
    .toBuffer();
}

async function px(buf: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

describe('composeMockup', () => {
  it('produces a 7:10 canvas with sheet visible through the window and frame on top', async () => {
    const out = await composeMockup({
      sheet: await syntheticSheet(),
      frame: await syntheticFrame(),
      window: WINDOW,
      outWidth: 700,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(700);
    expect(meta.height).toBe(1000);

    const centre = await px(out, 350, 500); // inside the window → red sheet
    expect(centre.r).toBeGreaterThan(180);
    expect(centre.g).toBeLessThan(80);

    const border = await px(out, 30, 500); // on the frame moulding → dark
    expect(border.r).toBeLessThan(60);

    const outside = await px(out, 2, 2); // outside nothing here (frame fills canvas) → dark too
    expect(outside.r).toBeLessThan(60);
  });

  it('flattens transparency onto the background colour', async () => {
    // Frame that covers only the middle 80% horizontally → margins show background.
    const inner = await syntheticFrame();
    const airFrame = await sharp({
      create: { width: 875, height: 1250, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: await sharp(inner).resize(700, 1000).png().toBuffer(), left: 87, top: 125 }])
      .png()
      .toBuffer();
    const out = await composeMockup({
      sheet: await syntheticSheet(),
      frame: airFrame,
      // window fractions relative to the 875×1250 canvas: same 0.7 ratio
      window: { left: 0.22, top: 0.22, width: 0.56, height: 0.56 },
      outWidth: 875,
    });
    const margin = await px(out, 5, 625); // in the transparent air → background
    // MOCKUP_DEFAULT_BACKGROUND '#F1EFEA' → r/g/b all > 220
    expect(margin.r).toBeGreaterThan(220);
    expect(margin.g).toBeGreaterThan(220);
    expect(margin.b).toBeGreaterThan(220);
    expect(MOCKUP_DEFAULT_BACKGROUND).toBe('#F1EFEA');
  });

  it('throws when the window ratio does not match the sheet ratio', async () => {
    await expect(
      composeMockup({
        sheet: await syntheticSheet(), // 0.7
        frame: await syntheticFrame(),
        window: { left: 0.15, top: 0.15, width: 0.7, height: 0.5 }, // 490/500 = 0.98
      }),
    ).rejects.toThrow(/window ratio/);
  });

  it('throws when the frame canvas is not 7:10', async () => {
    const square = await sharp({
      create: { width: 500, height: 500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    await expect(
      composeMockup({ sheet: await syntheticSheet(), frame: square, window: WINDOW }),
    ).rejects.toThrow(/frame canvas/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/print-mockups-compose.test.ts`
Expected: FAIL — `Cannot find module './print-mockups-compose'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/print-mockups-compose.ts`:

```ts
import sharp from 'sharp';

/* ------------------------------------------------------------------
   Mockup composition core for the print-assets:mockups pipeline step.
   Frame masters are full 7:10 canvases (air + baked shadow + moulding)
   with a transparent window where the sheet shows through; the window
   rect is configured as fractions of the canvas in
   config/print-assets/frames.json. Fail-closed on ratio mismatches so a
   misconfigured window can never ship a distorted sheet.
   ------------------------------------------------------------------ */

export interface MockupWindow {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MOCKUP_RATIO = 0.7; // canonical 7:10 canvas (width / height)
export const MOCKUP_RATIO_TOLERANCE = 0.02;
export const MOCKUP_DEFAULT_BACKGROUND = '#F1EFEA';

export async function composeMockup(opts: {
  sheet: Buffer;
  frame: Buffer;
  window: MockupWindow;
  outWidth?: number;
  background?: string;
}): Promise<Buffer> {
  const outWidth = opts.outWidth ?? 2000;
  const background = opts.background ?? MOCKUP_DEFAULT_BACKGROUND;
  const outHeight = Math.round(outWidth / MOCKUP_RATIO);

  const frameMeta = await sharp(opts.frame).metadata();
  if (!frameMeta.width || !frameMeta.height) throw new Error('frame master has no dimensions');
  const frameRatio = frameMeta.width / frameMeta.height;
  if (Math.abs(frameRatio - MOCKUP_RATIO) / MOCKUP_RATIO > MOCKUP_RATIO_TOLERANCE) {
    throw new Error(
      `frame canvas ratio ${frameRatio.toFixed(4)} is not the canonical ${MOCKUP_RATIO} (7:10)`,
    );
  }

  const winW = Math.round(outWidth * opts.window.width);
  const winH = Math.round(outHeight * opts.window.height);
  const sheetMeta = await sharp(opts.sheet).metadata();
  if (!sheetMeta.width || !sheetMeta.height) throw new Error('sheet source has no dimensions');
  const sheetRatio = sheetMeta.width / sheetMeta.height;
  const windowRatio = winW / winH;
  if (Math.abs(sheetRatio - windowRatio) / windowRatio > MOCKUP_RATIO_TOLERANCE) {
    throw new Error(
      `window ratio ${windowRatio.toFixed(4)} does not match sheet ratio ${sheetRatio.toFixed(4)} — fix the window in frames.json`,
    );
  }

  const [frameResized, sheetResized] = await Promise.all([
    sharp(opts.frame).resize(outWidth, outHeight, { fit: 'fill' }).png().toBuffer(),
    sharp(opts.sheet).resize(winW, winH, { fit: 'fill' }).png().toBuffer(),
  ]);

  return sharp({
    create: { width: outWidth, height: outHeight, channels: 4, background },
  })
    .composite([
      { input: sheetResized, left: Math.round(outWidth * opts.window.left), top: Math.round(outHeight * opts.window.top) },
      { input: frameResized, left: 0, top: 0 },
    ])
    .flatten({ background })
    .png()
    .toBuffer();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/print-mockups-compose.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/print-mockups-compose.ts src/lib/print-mockups-compose.test.ts
git commit -m "feat(prints): sharp composition core for pre-rendered mockups"
```

---

### Task 4: Pipeline CLI (`print-assets:mockups`) + shared helper extraction + docs

**Files:**
- Create: `scripts/lib/print-assets-storefront.ts`
- Modify: `scripts/print-assets-gallery.ts` (delete local `resolveSourcePath`, `WebpOutput`, `generateWebpSet`, `CANONICAL_MAX_WIDTH`, `WEBP_QUALITY`; import from the new lib)
- Create: `scripts/print-assets-mockups.ts`
- Create: `config/print-assets/frames.example.json`
- Modify: `package.json` (scripts block, after line 35 `print-assets:gallery`)
- Modify: `docs/print-asset-runbook.md` (new section at the end)
- Modify: `AGENTS.md` (Commands paragraph — extend the print-assets sentence)

**Interfaces:**
- Consumes: `composeMockup`, `MockupWindow`, `MOCKUP_DEFAULT_BACKGROUND` (Task 3); `designMockupStates`, `MockupState` (Task 1); `registryPrintById` from `src/lib/prints.ts`; existing script helpers: `getArg`, `hasFlag`, `loadManifest`, `localDerivativePath`, `revisionDir`, `ROOT` from `scripts/lib/print-assets-cli`; `resolveLatestReadyAsset`, `galleryR2Key`, `ReadyAssetDetail` from `scripts/lib/print-assets-resolve`; `printAssetsBucket`, `r2GetToFile`, `r2Put` from `scripts/lib/r2`; `hashFile` from `scripts/lib/image-facts`; `IMG_WIDTHS` from `src/lib/images`.
- Produces: `npm run print-assets:mockups -- --product fap01 [--revision R] [--state framed-black] [--dry-run]`; shared `resolveSourcePath(productId, asset, scratchDir, bucket)` and `generateWebpSet(source: Buffer | string, stem: string, scratchDir: string)` used by both gallery and mockups scripts.

- [ ] **Step 1: Extract shared storefront helpers**

Create `scripts/lib/print-assets-storefront.ts` with the two functions moved **verbatim** from `scripts/print-assets-gallery.ts` (lines 45-131), with two deltas: both are exported, and `generateWebpSet` accepts `Buffer | string` so the mockups script can pass an in-memory PNG:

```ts
/**
 * Shared helpers for storefront-facing WebP generation (gallery + mockups):
 * resolve a fulfilment derivative to a local file (prepare tree or R2
 * download with sha256 integrity check) and emit the canonical + srcset WebP
 * set for public/uploads.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { IMG_WIDTHS } from '../../src/lib/images';
import { loadManifest, localDerivativePath, revisionDir } from './print-assets-cli';
import { hashFile } from './image-facts';
import { r2GetToFile } from './r2';
import type { ReadyAssetDetail } from './print-assets-resolve';

export const CANONICAL_MAX_WIDTH = 1600;
export const WEBP_QUALITY = 80;

export interface WebpOutput {
  filename: string;
  localPath: string;
  r2Key: string;
  publicPath: string;
}

export async function resolveSourcePath(
  productId: string,
  asset: ReadyAssetDetail,
  scratchDir: string,
  bucket: string,
): Promise<{ path: string; cleanup: boolean }> {
  const manifestPath = path.join(revisionDir(productId, asset.revision), 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = loadManifest(productId, asset.revision);
    const derivative = manifest.derivatives.find((d) => d.profileKey === asset.profile_key);
    if (derivative) {
      const localPath = localDerivativePath(
        productId,
        asset.revision,
        derivative.profileKey,
        derivative.sha256,
        derivative.format,
      );
      if (fs.existsSync(localPath)) {
        return { path: localPath, cleanup: false };
      }
    }
  }

  const ext = path.extname(asset.r2_key) || '.jpg';
  const dest = path.join(scratchDir, `source-${asset.profile_key}${ext}`);
  const got = r2GetToFile(bucket, asset.r2_key, dest);
  if (!got.ok) {
    throw new Error(`Failed to download fulfilment source ${asset.r2_key}: ${got.error}`);
  }
  const downloadedSha = await hashFile(dest);
  if (downloadedSha !== asset.sha256) {
    throw new Error(
      `Integrity mismatch for ${asset.r2_key}: expected sha256 ${asset.sha256}, got ${downloadedSha}`,
    );
  }
  return { path: dest, cleanup: true };
}

export async function generateWebpSet(
  source: Buffer | string,
  stem: string,
  scratchDir: string,
): Promise<WebpOutput[]> {
  const outputs: WebpOutput[] = [];

  const canonicalName = `${stem}.webp`;
  const canonicalPath = path.join(scratchDir, canonicalName);
  await sharp(source)
    .resize({ width: CANONICAL_MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toFile(canonicalPath);
  outputs.push({
    filename: canonicalName,
    localPath: canonicalPath,
    r2Key: '',
    publicPath: `/uploads/${canonicalName}`,
  });

  for (const w of IMG_WIDTHS) {
    const variantName = `${stem}-${w}w.webp`;
    const variantPath = path.join(scratchDir, variantName);
    await sharp(source)
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(variantPath);
    outputs.push({
      filename: variantName,
      localPath: variantPath,
      r2Key: '',
      publicPath: `/uploads/${variantName}`,
    });
  }

  return outputs;
}
```

Then in `scripts/print-assets-gallery.ts`: delete lines 29 (`CANONICAL_MAX_WIDTH`), 31 (`WEBP_QUALITY`), 45-131 (`resolveSourcePath`, `WebpOutput`, `generateWebpSet`) and the now-unused imports (`sharp`, `IMG_WIDTHS`, `hashFile`, `r2GetToFile`, `loadManifest`, `localDerivativePath`, `revisionDir` — keep `ROOT`, `getArg`, `hasFlag`), and add:

```ts
import { generateWebpSet, resolveSourcePath } from './lib/print-assets-storefront';
```

- [ ] **Step 2: Verify the gallery script still typechecks and dry-runs**

Run: `npm run typecheck && npm run lint`
Expected: clean. (Functional parity: the helpers moved verbatim; a `--dry-run` against real credentials is an operator step, not CI — note it in the PR description.)

- [ ] **Step 3: Create the frames registry template**

Create `config/print-assets/frames.example.json`:

```json
{
  "_comment": "Frame-master registry for print-assets:mockups. Copy to frames.json once the masters exist under gitignored design/print-assets/frames/. Each master is a full 7:10 RGBA PNG (>= 2000 px wide): air + baked shadow + moulding (+ bevelled mat for mount variants), with a transparent window where the sheet shows through. window = fractions of the canvas; framed windows must match the FAP sheet ratio 0.70 (8400x12000), mount windows the CFPM aperture ratio 0.667 (7200x10800), within 2% tolerance (composeMockup fail-closes otherwise).",
  "background": "#F1EFEA",
  "frames": {
    "black": {
      "framed": { "file": "design/print-assets/frames/black-framed.png", "window": { "left": 0.14, "top": 0.14, "width": 0.72, "height": 0.72 } },
      "mount": { "file": "design/print-assets/frames/black-mount.png", "window": { "left": 0.2, "top": 0.185, "width": 0.6, "height": 0.63 } }
    },
    "white": {
      "framed": { "file": "design/print-assets/frames/white-framed.png", "window": { "left": 0.14, "top": 0.14, "width": 0.72, "height": 0.72 } },
      "mount": { "file": "design/print-assets/frames/white-mount.png", "window": { "left": 0.2, "top": 0.185, "width": 0.6, "height": 0.63 } }
    },
    "natural": {
      "framed": { "file": "design/print-assets/frames/natural-framed.png", "window": { "left": 0.14, "top": 0.14, "width": 0.72, "height": 0.72 } },
      "mount": { "file": "design/print-assets/frames/natural-mount.png", "window": { "left": 0.2, "top": 0.185, "width": 0.6, "height": 0.63 } }
    }
  }
}
```

(The window values are documented starting points; the activation task calibrates them against the real masters — the ratio guard in `composeMockup` catches any window that would distort the sheet.)

- [ ] **Step 4: Create the CLI script**

Create `scripts/print-assets-mockups.ts`:

```ts
/**
 * Compose configurator mockup WebPs (framed / framed+mount × colour) for a
 * print design from its published fulfilment derivatives + shared frame
 * masters, upload to R2 under prints/{productId}/gallery/mock-{state}/ and
 * mirror to public/uploads/ for srcSet() delivery.
 *
 * Usage:
 *   npm run print-assets:mockups -- --product fap01
 *   npm run print-assets:mockups -- --product fap01 --state framed-black --dry-run
 *   npm run print-assets:mockups -- --product fap01 --revision 2026-07-12-r1
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, Wrangler R2 access,
 * config/print-assets/frames.json and the frame masters it points at.
 * Spec: docs/superpowers/specs/2026-07-19-print-configurator-live-mockup-design.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registryPrintById } from '../src/lib/prints';
import { designMockupStates, type MockupState } from '../src/lib/print-mockups';
import { composeMockup, type MockupWindow } from '../src/lib/print-mockups-compose';
import type { PrintFrameColour } from '../src/lib/types';
import { getArg, hasFlag, ROOT } from './lib/print-assets-cli';
import { galleryR2Key, resolveLatestReadyAsset } from './lib/print-assets-resolve';
import { generateWebpSet, resolveSourcePath } from './lib/print-assets-storefront';
import { printAssetsBucket, r2Put } from './lib/r2';

/** Canonical 7:10 sources (spec decision 2): FAP sheet / CFPM aperture. */
const SOURCE_PROFILE = { framed: '8400x12000', mount: '7200x10800' } as const;
const OUT_WIDTH = 2000;

interface FrameLayer {
  file: string;
  window: MockupWindow;
}
interface FramesConfig {
  background: string;
  frames: Partial<Record<PrintFrameColour, { framed: FrameLayer; mount?: FrameLayer }>>;
}

function loadFramesConfig(): FramesConfig {
  const p = path.join(ROOT, 'config', 'print-assets', 'frames.json');
  if (!fs.existsSync(p)) {
    throw new Error(
      'Missing config/print-assets/frames.json — copy frames.example.json and point it at the frame masters.',
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as FramesConfig;
}

function frameLayer(config: FramesConfig, state: Exclude<MockupState, 'plain'>): FrameLayer {
  const [kind, colour] = state.split('-') as ['framed' | 'mount', PrintFrameColour];
  const entry = config.frames[colour];
  const layer = kind === 'mount' ? entry?.mount : entry?.framed;
  if (!layer) throw new Error(`frames.json has no ${kind} master for colour "${colour}"`);
  const masterPath = path.isAbsolute(layer.file) ? layer.file : path.join(ROOT, layer.file);
  if (!fs.existsSync(masterPath)) {
    throw new Error(`Frame master not found: ${layer.file} (state ${state})`);
  }
  return { ...layer, file: masterPath };
}

async function main(): Promise<void> {
  const productId = getArg('product');
  const revisionArg = getArg('revision');
  const stateFilter = getArg('state');
  const dryRun = hasFlag('dry-run');

  if (!productId) throw new Error('Missing --product (e.g. --product fap01)');
  const design = registryPrintById(productId);
  if (!design) throw new Error(`Unknown print design "${productId}"`);

  const states = designMockupStates(design).filter(
    (s) => !stateFilter || s === stateFilter,
  ) as Exclude<MockupState, 'plain'>[];
  if (states.length === 0) {
    throw new Error(stateFilter ? `State "${stateFilter}" not offered by ${productId}` : `${productId} offers no framed states`);
  }

  const framesConfig = loadFramesConfig();
  for (const state of states) frameLayer(framesConfig, state); // fail fast before any I/O

  const bucket = printAssetsBucket();
  const stem = path.basename(design.image, path.extname(design.image)); // 'fap-01'
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-assets-mockups-'));

  try {
    // Resolve each needed source profile once (framed and/or mount).
    const kinds = [...new Set(states.map((s) => s.split('-')[0] as 'framed' | 'mount'))];
    const sheets = new Map<'framed' | 'mount', Buffer>();
    for (const kind of kinds) {
      const asset = await resolveLatestReadyAsset(productId, SOURCE_PROFILE[kind], revisionArg);
      console.log(
        `source[${kind}]: profile=${asset.profile_key} revision=${asset.revision} ${asset.r2_key}`,
      );
      const { path: sourcePath } = await resolveSourcePath(productId, asset, scratchDir, bucket);
      sheets.set(kind, fs.readFileSync(sourcePath));
    }

    for (const state of states) {
      const kind = state.split('-')[0] as 'framed' | 'mount';
      const layer = frameLayer(framesConfig, state);
      const png = await composeMockup({
        sheet: sheets.get(kind)!,
        frame: fs.readFileSync(layer.file),
        window: layer.window,
        outWidth: OUT_WIDTH,
        background: framesConfig.background,
      });
      const webps = await generateWebpSet(png, `${stem}-mock-${state}`, scratchDir);
      for (const file of webps) {
        file.r2Key = galleryR2Key(productId, `mock-${state}`, file.filename);
        const sizeKb = (fs.statSync(file.localPath).size / 1024).toFixed(0);
        if (dryRun) {
          console.log(`  would write R2 ${file.r2Key} (${sizeKb} KB) + mirror ${file.publicPath}`);
          continue;
        }
        const put = r2Put(bucket, file.r2Key, file.localPath, 'image/webp');
        if (!put.ok) throw new Error(`R2 upload failed for ${file.r2Key}: ${put.error}`);
        fs.copyFileSync(file.localPath, path.join(ROOT, 'public', file.publicPath));
        console.log(`  ${file.filename} → R2 + ${file.publicPath} (${sizeKb} KB)`);
      }
    }

    console.log(
      `\nDone. ${states.length} mockup state(s) for ${productId}.` +
        (dryRun ? ' [DRY RUN]' : ` Set \`mockups: true\` on ${productId} in src/lib/prints.ts and commit public/uploads/${stem}-mock-*.webp together.`),
    );
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 5: Register the npm script**

In `package.json`, after the `"print-assets:gallery"` line (line 35), add:

```json
    "print-assets:mockups": "tsx scripts/print-assets-mockups.ts",
```

- [ ] **Step 6: Document the operator procedure**

Append to `docs/print-asset-runbook.md`:

```markdown
## Configurator mockups (`print-assets:mockups`)

Pre-rendered hero states for the PDP live-mockup feature (spec
`docs/superpowers/specs/2026-07-19-print-configurator-live-mockup-design.md`).

Prerequisites: the design's fulfilment revision is published (`ready`);
`config/print-assets/frames.json` exists (copy `frames.example.json`) and its
`file` entries point at the frame masters under gitignored
`design/print-assets/frames/` (full 7:10 RGBA PNGs ≥ 2000 px wide, transparent
window, baked shadow; mount masters include the bevelled mat).

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
```

In `AGENTS.md`, in the Commands section sentence describing the print-asset pipeline, after the `print-assets:gallery` entry, insert:

```markdown
`npm run print-assets:mockups` (pre-rendered configurator hero mockups — composes published FAP/CFPM derivatives into shared frame masters from `config/print-assets/frames.json`; `--product` required, optional `--state`/`--revision`/`--dry-run`; ships together with the design's `mockups: true` flag),
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: clean; the Task 3 compose tests still pass. Then:

Run: `npm run print-assets:mockups -- --product fap01 --dry-run`
Expected (no `frames.json` yet): exit 1 with `Missing config/print-assets/frames.json — copy frames.example.json…` — proves the fail-fast path. (A full dry-run needs Supabase/R2 credentials + masters; that is the activation task.)

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/print-assets-storefront.ts scripts/print-assets-gallery.ts scripts/print-assets-mockups.ts config/print-assets/frames.example.json package.json docs/print-asset-runbook.md AGENTS.md
git commit -m "feat(print-assets): mockups pipeline step composing frame masters"
```

---

### Task 5: E2E coverage

**Files:**
- Modify: `e2e/print-configurator.spec.ts` (append two tests inside the existing `test.describe('fine-art print configurator @ci', …)` block)

**Interfaces:**
- Consumes: `registryPrintById`, `PRINT_DESIGNS` from `src/lib/prints.ts` (safe to import in specs: pure registry, no env/server side effects at module load); `mockupHeroSrc` naming convention from Task 1; `data-testid` hooks already in `PrintConfigurator`.
- Produces: `@ci` coverage that activates automatically when a design gains `mockups: true`.

- [ ] **Step 1: Append the two tests**

Add inside the describe block of `e2e/print-configurator.spec.ts`:

```ts
  test('hero mockup follows configurator selection', async ({ page }) => {
    const design = registryPrintById('fap01');
    test.skip(!design?.mockups, 'fap01 mockup assets not published yet (flag off)');

    await page.goto('/fine-art-prints/fap01');
    const hero = page.locator('.pdp-img-main img');
    await expect(hero).toHaveAttribute('src', '/uploads/fap-01.webp');

    // Framing defaults to the first colour (black).
    await page.getByTestId('opt-framed-true').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-01-mock-framed-black.webp');

    await page.getByTestId('opt-mount-true').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-01-mock-mount-black.webp');

    await page.getByTestId('opt-colour-natural').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-01-mock-mount-natural.webp');

    await page.getByTestId('opt-framed-false').click();
    await expect(hero).toHaveAttribute('src', '/uploads/fap-01.webp');
  });

  test('design without mockups keeps a static hero', async ({ page }) => {
    const design = PRINT_DESIGNS.find((d) => d.published && !d.mockups && d.frameColours.length > 0);
    test.skip(!design, 'every published design already has mockups');

    await page.goto(`/fine-art-prints/${design!.id}`);
    const hero = page.locator('.pdp-img-main img');
    await expect(hero).toHaveAttribute('src', design!.image);
    await page.getByTestId('opt-framed-true').click();
    await expect(hero).toHaveAttribute('src', design!.image);
  });
```

And extend the imports at the top of the file:

```ts
import { PRINT_DESIGNS, registryPrintById } from '../src/lib/prints';
```

- [ ] **Step 2: Run the spec**

Run: `npx playwright test e2e/print-configurator.spec.ts`
Expected: existing 3 tests PASS; `hero mockup follows configurator selection` **skipped** (flag off); `design without mockups keeps a static hero` PASS (runs against fap01 or fap02).

- [ ] **Step 3: Commit**

```bash
git add e2e/print-configurator.spec.ts
git commit -m "test(e2e): hero mockup swap + static-hero regression coverage"
```

---

### Task 6: Activation (deferred — blocked on frame masters)

No code. Operator checklist, runnable only once the three photorealistic frame masters exist (spec Open item 1: Prodigi Classic Frame in black/white/natural, full 7:10 RGBA PNGs ≥ 2000 px wide with transparent window + baked shadow; mount variants with bevelled mat — 6 files total under `design/print-assets/frames/`).

- [ ] Copy `config/print-assets/frames.example.json` → `config/print-assets/frames.json`; set each `file`; calibrate each `window` (measure the transparent rect in the master: `left = x/canvasW`, etc.). `composeMockup` throws on any window whose ratio drifts >2% from its sheet (0.70 framed / 0.667 mount) — iterate until clean.
- [ ] Run `npm run print-assets:mockups -- --product fap01 --dry-run`, review the plan, then run without `--dry-run` (needs `SUPABASE_*` + wrangler auth, same as `print-assets:gallery`).
- [ ] Visually inspect `public/uploads/fap-01-mock-*.webp` (6 states) — sheet not distorted, shadow direction consistent across colours, background `#F1EFEA` matches the PDP.
- [ ] Set `mockups: true` on `fap01` in `src/lib/prints.ts` (`PRINT_DESIGNS[0]`).
- [ ] Run `npx playwright test e2e/print-configurator.spec.ts` — the swap test now RUNS and must PASS; run `npm run test && npm run typecheck && npm run lint && npm run build`.
- [ ] Commit the WebPs + flag together: `git add public/uploads/fap-01-mock-*.webp src/lib/prints.ts config/print-assets/frames.json && git commit -m "feat(prints): enable live mockups for fap01"`.
- [ ] After fap02/fap03 fulfilment assets are published (separate ongoing effort), repeat for each (`fap02` produces only `framed-black`/`framed-white`).

---

## Execution notes

- Task order is strict: 1 → 2 → (3, 4 in either order; 4 needs 3) → 5. Task 6 is deferred until masters are delivered.
- Tasks 1-5 ship a user-invisible feature (flag off everywhere) — safe to merge to `main` behind the normal PR flow before any masters exist.
- PR title should be `feat:`-prefixed so release-please cuts a version.
