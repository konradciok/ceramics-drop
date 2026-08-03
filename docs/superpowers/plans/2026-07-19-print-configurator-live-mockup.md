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
- Pricing, cart-token format, checkout validation, and fulfilment paths are mechanically untouched. The frame-colour contract IS in scope: Task 0 remaps the `PRODIGI_SKU_MAP` keys (white → brown) and swaps the required `print.colour_*` labels (drop `colour_white`, add `colour_brown`) in all of `messages/{pl,en,es,de}.json`.
- No i18n strings beyond that label swap (`variantLabel` from `src/lib/print-cart.ts` is reused for alt text); if copy is ever added it must land in all of `messages/{pl,en,es,de}.json`.
- Designs without `mockups: true` must render byte-identical to today (feature is purely additive).
- Canonical mockup ratio is 7:10 (`width/height = 0.7`); framed states composite the `8400x12000` FAP profile, mount states the `7200x10800` CFPM profile.
- Frame colour axis after Task 0 is `black | natural | brown` (variantLabel pl: czarna / jasnobrązowa / ciemnobrązowa; `white` dropped; fap02 = black + natural). Internal keys ARE Prodigi `attributes.color` values — verified against the live enum (`black`, `brown`, `natural` all valid).
- Per-colour print-area exception (prodigi/sku-catalog.md:84): at 30×40 the CFP print area is 3614×4795 **only for black** after the swap; brown and natural are 3600×4800. All other sizes and all CFPM entries are colour-uniform.
- Frame masters are opaque blanks in gitignored `design/print-assets/frames_blanks/`; the sheet is composited OVER the window rect, then centre-cropped to 7:10. No alpha channel required; JPG tolerated, PNG preferred.
- Monetary rules, analytics event contract, and locale routing are out of scope and must not change.

## File Map

| File | Role |
|---|---|
| **Task 0 (own PR):** `src/lib/types.ts`, `src/lib/print-cart.ts`, `src/lib/prints.ts`, `src/styles/site.css`, `messages/{pl,en,es,de}.json`, `prodigi/sku-catalog.md`, tests | Frame-colour axis swap white→brown |
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

Execution branches (stacked, per-domain PRs): **PR 1** = Task 0 (`feat/print-frame-colour-swap`), **PR 2** = Tasks 1–5 (`feat/print-live-mockup`, stacked on PR 1), **PR 3** = Task 6 activation (later, when masters exist). Do not touch the pre-existing dirty files `config/print-assets/fap0*.json` — they belong to a parallel revision effort.

---

### Task 0: Frame-colour axis swap (white → brown; natural relabelled "jasny brąz")

**Files:**
- Modify: `src/lib/types.ts` (the `PrintFrameColour` union)
- Modify: `src/lib/print-cart.ts` (`PRINT_FRAME_COLOURS`, `COLOUR_LABEL`, `PRODIGI_SKU_MAP`)
- Modify: `src/lib/prints.ts` (`frameColours` on all four designs)
- Modify: `src/styles/site.css:1222-1224` (colour swatches)
- Modify: `messages/pl.json`, `messages/en.json`, `messages/es.json`, `messages/de.json` (`print.colour_*` keys, ~line 851-853 in each)
- Modify: `prodigi/sku-catalog.md` (colour rows/notes: lines 72-84 and 116)
- Modify: `src/lib/print-prodigi-attributes.test.ts`, `src/lib/print-pricing.test.ts` (replace `'white'` selection fixtures with `'brown'`; do NOT touch the `'Snow white'` mountColor literal)
- Test: `src/lib/print-cart.test.ts` (new assertions)

**Interfaces:**
- Consumes: nothing from other tasks (this is the prerequisite PR).
- Produces: `PrintFrameColour = 'black' | 'natural' | 'brown'` — every later task's `MockupState` union, tests, and frames.json colours build on this. Prodigi mapping needs no code change: `buildProdigiAttributes` passes `sel.frameColour` verbatim and `black`/`natural`/`brown` are valid `attributes.color` values (verified via `npm run prodigi -- product get GLOBAL-CFP-20X28`).

- [ ] **Step 1: Write the failing test**

Append to `src/lib/print-cart.test.ts`:

```ts
describe('PRODIGI_SKU_MAP — brown replaces white (2026-07-19 colour swap)', () => {
  it('maps brown with per-colour print areas (30x40 CFP exception is black-only)', () => {
    expect(PRODIGI_SKU_MAP['30x40:true:false:brown']).toEqual({
      sku: 'GLOBAL-CFP-12X16',
      printAreaPx: { w: 3600, h: 4800 },
    });
    expect(PRODIGI_SKU_MAP['30x40:true:true:brown']).toEqual({
      sku: 'GLOBAL-CFPM-12X16',
      printAreaPx: { w: 2400, h: 3600 },
    });
    expect(PRODIGI_SKU_MAP['50x70:true:false:brown']).toEqual({
      sku: 'GLOBAL-CFP-20X28',
      printAreaPx: { w: 6000, h: 8400 },
    });
    expect(PRODIGI_SKU_MAP['70x100:true:false:brown']).toEqual({
      sku: 'GLOBAL-CFP-28X40',
      printAreaPx: { w: 8400, h: 12000 },
    });
  });

  it('has no white keys and still exactly 21 entries', () => {
    expect(Object.keys(PRODIGI_SKU_MAP).some((k) => k.endsWith(':white'))).toBe(false);
    expect(Object.keys(PRODIGI_SKU_MAP)).toHaveLength(21);
  });
});
```

(`PRODIGI_SKU_MAP` is already imported in this test file; if not, add it to the existing import from `./print-cart`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/print-cart.test.ts`
Expected: FAIL — `PRODIGI_SKU_MAP['30x40:true:false:brown']` is undefined.

- [ ] **Step 3: Swap the axis across the five source files**

`src/lib/types.ts` — replace the union:

```ts
export type PrintFrameColour = 'black' | 'natural' | 'brown';
```

`src/lib/print-cart.ts`:

```ts
export const PRINT_FRAME_COLOURS: readonly PrintFrameColour[] = ['black', 'natural', 'brown'];
```

```ts
const COLOUR_LABEL: Record<string, Record<PrintFrameColour, string>> = {
  pl: { black: 'czarna', natural: 'jasnobrązowa', brown: 'ciemnobrązowa' },
  en: { black: 'black', natural: 'light brown', brown: 'dark brown' },
  es: { black: 'negro', natural: 'marrón claro', brown: 'marrón oscuro' },
  de: { black: 'schwarz', natural: 'hellbraun', brown: 'dunkelbraun' },
  gb: { black: 'black', natural: 'light brown', brown: 'dark brown' },
};
```

`PRODIGI_SKU_MAP` — full replacement (21 entries; brown takes the 3600×4800 areas everywhere the sheet is 30×40, per `prodigi/sku-catalog.md:84`):

```ts
export const PRODIGI_SKU_MAP: Record<string, { sku: string; printAreaPx: { w: number; h: number } }> = {
  '30x40:false:false:none':    { sku: 'GLOBAL-FAP-12X16',  printAreaPx: { w: 3600, h: 4800 } },
  '30x40:true:false:black':    { sku: 'GLOBAL-CFP-12X16',  printAreaPx: { w: 3614, h: 4795 } },
  '30x40:true:false:natural':  { sku: 'GLOBAL-CFP-12X16',  printAreaPx: { w: 3600, h: 4800 } },
  '30x40:true:false:brown':    { sku: 'GLOBAL-CFP-12X16',  printAreaPx: { w: 3600, h: 4800 } },
  '30x40:true:true:black':     { sku: 'GLOBAL-CFPM-12X16', printAreaPx: { w: 2400, h: 3600 } },
  '30x40:true:true:natural':   { sku: 'GLOBAL-CFPM-12X16', printAreaPx: { w: 2400, h: 3600 } },
  '30x40:true:true:brown':     { sku: 'GLOBAL-CFPM-12X16', printAreaPx: { w: 2400, h: 3600 } },
  '50x70:false:false:none':    { sku: 'GLOBAL-FAP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:false:black':    { sku: 'GLOBAL-CFP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:false:natural':  { sku: 'GLOBAL-CFP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:false:brown':    { sku: 'GLOBAL-CFP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:true:black':     { sku: 'GLOBAL-CFPM-20X28', printAreaPx: { w: 4800, h: 7200 } },
  '50x70:true:true:natural':   { sku: 'GLOBAL-CFPM-20X28', printAreaPx: { w: 4800, h: 7200 } },
  '50x70:true:true:brown':     { sku: 'GLOBAL-CFPM-20X28', printAreaPx: { w: 4800, h: 7200 } },
  '70x100:false:false:none':   { sku: 'GLOBAL-FAP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:false:black':   { sku: 'GLOBAL-CFP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:false:natural': { sku: 'GLOBAL-CFP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:false:brown':   { sku: 'GLOBAL-CFP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:true:black':    { sku: 'GLOBAL-CFPM-28X40', printAreaPx: { w: 7200, h: 10800 } },
  '70x100:true:true:natural':  { sku: 'GLOBAL-CFPM-28X40', printAreaPx: { w: 7200, h: 10800 } },
  '70x100:true:true:brown':    { sku: 'GLOBAL-CFPM-28X40', printAreaPx: { w: 7200, h: 10800 } },
};
```

`src/lib/prints.ts` — `frameColours` per design: fap01 `['black', 'natural', 'brown']`, fap02 `['black', 'natural']`, fap03 `['black', 'natural', 'brown']`, fap04 `['black', 'natural', 'brown']`. (Order = configurator button order; `frameColours[0]` = default colour when framing is toggled on, so black stays the default.)

`src/styles/site.css:1222-1224` — replace the three swatch rules:

```css
.print-opt-colour[data-colour="black"]::before { background:#141414; border-color:rgba(250,246,236,.35); }
.print-opt-colour[data-colour="natural"]::before { background:var(--c-sand); }
.print-opt-colour[data-colour="brown"]::before { background:var(--c-espresso); }
```

(`--c-espresso` `#3A2818` is a dark brown — it was previously mis-doubling as the "black" swatch; black gets a true near-black literal.)

`messages/{pl,en,es,de}.json` — in each file's `print` block replace the `colour_white` key and relabel `colour_natural`:

| key | pl | en | es | de |
|---|---|---|---|---|
| `colour_black` | `Czarna` | `Black` | `Negro` | `Schwarz` |
| `colour_natural` | `Jasny brąz` | `Light brown` | `Marrón claro` | `Hellbraun` |
| `colour_brown` (replaces `colour_white`) | `Ciemny brąz` | `Dark brown` | `Marrón oscuro` | `Dunkelbraun` |

`prodigi/sku-catalog.md` — update the 30×40 colour table rows (lines 72-78: `white` row becomes `brown` with print area 3600×4800), the line-84 note (the 3614×4795 exception is now black-only), the 50×70/70×100 row labels (`black / white / natural` → `black / natural / brown`), and the line-116 offered-colours note.

- [ ] **Step 4: Fix the two test fixtures that used white**

In `src/lib/print-prodigi-attributes.test.ts` and `src/lib/print-pricing.test.ts`, replace `frameColour: 'white'` (and any `'white'` variant-key literals) with `'brown'`. Leave `mountColor: 'Snow white'` expectations untouched — that is a Prodigi attribute value, not our axis.

- [ ] **Step 5: Run the full gate**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS. The compiler is the safety net — any missed `'white'` literal in print modules is a type error now.

Run: `grep -rn "'white'\|:white" src e2e scripts --include='*.ts' --include='*.tsx' | grep -v 'Snow white'`
Expected: no hits in print-related modules (ceramic/unrelated hits are fine — inspect anything that mentions prints).

Run: `npx playwright test e2e/print-configurator.spec.ts`
Expected: PASS (the spec clicks `opt-colour-natural` / `opt-colour-black`, both still exist).

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/print-cart.ts src/lib/prints.ts src/styles/site.css messages/pl.json messages/en.json messages/es.json messages/de.json prodigi/sku-catalog.md src/lib/print-cart.test.ts src/lib/print-prodigi-attributes.test.ts src/lib/print-pricing.test.ts
git commit -m "feat(prints): swap white frame for brown; relabel natural as light brown"
```

- [ ] **Step 7: Post-merge operator steps (production data)**

After PR 1 merges (nothing has ever been sold via Prodigi — `prodigi_orders` is empty — so this is a safe rename):

1. `npm run catalog:backfill` — reseeds `products` / `product_variants` from the registry (idempotent). Verify no active white rows remain:
   `select count(*) from product_variants where product_id like 'fap%' and variant_key like '%:white' and active;` → expect `0` (if the backfill only upserts and does not deactivate stale keys, deactivate them with an UPDATE and note it in the PR).
2. Re-assign fap01's published assets to the new active variant set:
   `npm run print-assets:publish -- --product fap01 --revision 2026-07-12-r1 --confirm 2026-07-12-r1`
   (publish assigns the revision to every active variant; the brown 30×40 rows pick the 3600×4800 derivative — the same one natural uses). Verify: the PDP coverage query returns `usable` for all 21 fap01 variants.
3. Optional sanity: `npm run sync-prodigi-skus` (SKUs are colour-agnostic, so `pod_variants` should be unchanged) and `npm run i18n:push` to sync the new `print.colour_*` strings to Notion.
4. Old cart tokens containing `:white:` in visitors' localStorage now fail `decodePrintToken` and are silently dropped from carts — acceptable (no paid print orders exist).

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
  frameColours: ['black', 'natural', 'brown'],
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
    expect(mockupState(sel({ framed: true, frameColour: 'natural' }))).toBe('framed-natural');
    expect(mockupState(sel({ framed: true, frameColour: 'brown' }))).toBe('framed-brown');
    expect(mockupState(sel({ framed: true, mount: true, frameColour: 'black' }))).toBe('mount-black');
    expect(mockupState(sel({ framed: true, mount: true, frameColour: 'natural' }))).toBe('mount-natural');
    expect(mockupState(sel({ framed: true, mount: true, frameColour: 'brown' }))).toBe('mount-brown');
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
    expect(mockupHeroSrc(flagged, sel({ framed: true, frameColour: 'brown' }))).toBe(
      '/uploads/fap-01-mock-framed-brown.webp',
    );
    expect(mockupHeroSrc(flagged, sel({}))).toBe('/uploads/fap-01.webp');
    expect(mockupHeroSrc(design, sel({ framed: true, frameColour: 'brown' }))).toBe('/uploads/fap-01.webp');
  });
});

describe('designMockupStates', () => {
  it('enumerates framed+mount states for full-axis designs (no plain)', () => {
    expect(designMockupStates(design)).toEqual([
      'framed-black', 'mount-black',
      'framed-natural', 'mount-natural',
      'framed-brown', 'mount-brown',
    ]);
  });

  it('respects narrower axes (fap02 shape: 2 colours, no mount)', () => {
    const narrow: PrintDesign = { ...design, frameColours: ['black', 'natural'], mountAvailable: false };
    expect(designMockupStates(narrow)).toEqual(['framed-black', 'framed-natural']);
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
  - `interface MockupWindow { left: number; top: number; width: number; height: number }` (fractions of the MASTER canvas)
  - `composeMockup(opts: { master: Buffer; sheet: Buffer; window: MockupWindow; outWidth?: number; background?: string }): Promise<Buffer>` — pastes the sheet OVER the opaque master's window rect, centre-crops to 7:10 anchored on the window centre, returns a PNG at `outWidth × round(outWidth/0.7)`; throws on window/sheet ratio mismatch or a window outside the canvas.
  - `const MOCKUP_RATIO = 0.7`, `const MOCKUP_RATIO_TOLERANCE = 0.02`, `const MOCKUP_DEFAULT_BACKGROUND = '#F1EFEA'`

Masters are opaque blanks (baked background + shadow, any canvas ratio — the real ones are square); no transparency is required, which is why the sheet goes ON TOP of the window instead of behind a punched-out hole. This module lives in `src/lib/` (not `scripts/`) so Vitest covers it the same way it covers `print-assets-prepare.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/print-mockups-compose.test.ts`:

```ts
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { composeMockup } from './print-mockups-compose';

// Window on a square 1000×1000 master: 400×571 px → ratio 0.7005 (sheet 0.7).
const WINDOW = { left: 0.3, top: 0.15, width: 0.4, height: 0.571 };

/** Opaque square blank like the real ones: grey bg, dark moulding, white window. */
async function syntheticMaster(): Promise<Buffer> {
  const moulding = await sharp({
    create: { width: 480, height: 651, channels: 3, background: { r: 25, g: 25, b: 25 } },
  }).png().toBuffer();
  const window = await sharp({
    create: { width: 400, height: 571, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
  return sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .composite([
      { input: moulding, left: 260, top: 110 },
      { input: window, left: 300, top: 150 },
    ])
    .png()
    .toBuffer();
}

/** Solid red sheet at the FAP 7:10 ratio. */
async function syntheticSheet(): Promise<Buffer> {
  return sharp({
    create: { width: 350, height: 500, channels: 3, background: { r: 220, g: 30, b: 30 } },
  }).jpeg().toBuffer();
}

async function px(buf: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

describe('composeMockup', () => {
  it('pastes the sheet over the window and centre-crops the square master to 7:10', async () => {
    const out = await composeMockup({
      master: await syntheticMaster(),
      sheet: await syntheticSheet(),
      window: WINDOW,
      outWidth: 700,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(700);
    expect(meta.height).toBe(1000);

    // Square master (1000×1000) → crop is 700 wide, anchored on the window
    // centre x=500 → cropLeft = 150. Master (x,y) maps to crop (x-150, y).
    const centre = await px(out, 350, 435); // window centre (500, 435) → red sheet
    expect(centre.r).toBeGreaterThan(180);
    expect(centre.g).toBeLessThan(80);

    const moulding = await px(out, 120, 435); // master (270, 435) → dark moulding
    expect(moulding.r).toBeLessThan(60);

    const air = await px(out, 10, 50); // master (160, 50) → grey blank background
    expect(air.r).toBeGreaterThan(225);
  });

  it('crops a narrow master vertically and still outputs outWidth × outWidth/0.7', async () => {
    // 600×1000 grey master, window 400×571 centred: W/H = 0.6 < 0.7 → vertical crop.
    const window = await sharp({
      create: { width: 400, height: 571, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer();
    const master = await sharp({
      create: { width: 600, height: 1000, channels: 3, background: { r: 240, g: 240, b: 240 } },
    })
      .composite([{ input: window, left: 100, top: 150 }])
      .png()
      .toBuffer();
    const out = await composeMockup({
      master,
      sheet: await syntheticSheet(),
      window: { left: 100 / 600, top: 0.15, width: 400 / 600, height: 0.571 },
      outWidth: 700,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(700);
    expect(meta.height).toBe(1000);
  });

  it('throws when the window ratio does not match the sheet ratio', async () => {
    await expect(
      composeMockup({
        master: await syntheticMaster(),
        sheet: await syntheticSheet(), // 0.7
        window: { left: 0.3, top: 0.15, width: 0.4, height: 0.4 }, // ratio 1.0
      }),
    ).rejects.toThrow(/window ratio/);
  });

  it('throws when the window exceeds the master canvas', async () => {
    await expect(
      composeMockup({
        master: await syntheticMaster(),
        sheet: await syntheticSheet(),
        window: { left: 0.8, top: 0.15, width: 0.4, height: 0.571 },
      }),
    ).rejects.toThrow(/exceeds/);
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
   Frame masters are OPAQUE mockup blanks (design/print-assets/
   frames_blanks/): baked background + shadow + moulding, any canvas
   ratio (the real ones are square). The sheet is composited OVER the
   master's window rect (fractions of the master canvas, configured per
   master in config/print-assets/frames.json), then the canvas is
   centre-cropped to the canonical 7:10 anchored on the window centre.
   Fail-closed on ratio mismatches so a misconfigured window can never
   ship a distorted sheet.
   ------------------------------------------------------------------ */

export interface MockupWindow {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MOCKUP_RATIO = 0.7; // canonical 7:10 output (width / height)
export const MOCKUP_RATIO_TOLERANCE = 0.02;
export const MOCKUP_DEFAULT_BACKGROUND = '#F1EFEA';

export async function composeMockup(opts: {
  master: Buffer;
  sheet: Buffer;
  window: MockupWindow;
  outWidth?: number;
  background?: string;
}): Promise<Buffer> {
  const outWidth = opts.outWidth ?? 2000;
  const background = opts.background ?? MOCKUP_DEFAULT_BACKGROUND;
  const win = opts.window;
  if (
    !Number.isFinite(win.left) ||
    !Number.isFinite(win.top) ||
    !Number.isFinite(win.width) ||
    !Number.isFinite(win.height) ||
    win.width <= 0 ||
    win.height <= 0
  ) {
    throw new Error(`window has non-finite or non-positive dimensions: ${JSON.stringify(win)}`);
  }
  if (win.left < 0 || win.top < 0 || win.left + win.width > 1 || win.top + win.height > 1) {
    throw new Error(`window exceeds the master canvas: ${JSON.stringify(win)}`);
  }

  const masterMeta = await sharp(opts.master).metadata();
  if (!masterMeta.width || !masterMeta.height) throw new Error('master has no dimensions');
  const W = masterMeta.width;
  const H = masterMeta.height;

  const wx = Math.round(W * win.left);
  const wy = Math.round(H * win.top);
  const ww = Math.round(W * win.width);
  const wh = Math.round(H * win.height);

  const sheetMeta = await sharp(opts.sheet).metadata();
  if (!sheetMeta.width || !sheetMeta.height) throw new Error('sheet has no dimensions');
  const sheetRatio = sheetMeta.width / sheetMeta.height;
  const windowRatio = ww / wh;
  if (Math.abs(sheetRatio - windowRatio) / windowRatio > MOCKUP_RATIO_TOLERANCE) {
    throw new Error(
      `window ratio ${windowRatio.toFixed(4)} does not match sheet ratio ${sheetRatio.toFixed(4)} — fix the window in frames.json`,
    );
  }

  const sheetResized = await sharp(opts.sheet).resize(ww, wh, { fit: 'fill' }).png().toBuffer();
  const composed = await sharp(opts.master)
    .composite([{ input: sheetResized, left: wx, top: wy }])
    .flatten({ background }) // no-op for opaque masters; safety for alpha PNGs
    .png()
    .toBuffer();

  // Centre-crop to the canonical 7:10, anchored on the window centre (clamped).
  let cropLeft = 0;
  let cropTop = 0;
  let cropW = W;
  let cropH = H;
  if (W / H > MOCKUP_RATIO) {
    cropW = Math.round(H * MOCKUP_RATIO);
    const cx = wx + ww / 2;
    cropLeft = Math.min(Math.max(Math.round(cx - cropW / 2), 0), W - cropW);
  } else if (W / H < MOCKUP_RATIO) {
    cropH = Math.round(W / MOCKUP_RATIO);
    const cy = wy + wh / 2;
    cropTop = Math.min(Math.max(Math.round(cy - cropH / 2), 0), H - cropH);
  }

  return sharp(composed)
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .resize(outWidth, Math.round(outWidth / MOCKUP_RATIO), { fit: 'fill' })
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
  "_comment": "Frame-master registry for print-assets:mockups. Copy to frames.json once all six masters exist under gitignored design/print-assets/frames_blanks/. Masters are OPAQUE blanks (baked background + shadow, any canvas ratio); window = the sheet rect as fractions of the master canvas — the sheet is composited OVER it, then centre-cropped to 7:10. Framed windows must match the FAP sheet ratio 0.70, mount windows the CFPM aperture ratio 0.667, within 2% (composeMockup fail-closes otherwise). Framed windows below are MEASURED from the real blanks (2026-07-19); mount windows are derived starting points assuming the mount masters follow the runbook recipe (aperture 85.7% x 90% of the framed window, centred) — re-measure after drawing them. brown_framed: the current .jpg has window ratio 0.746 (different mockup source) and MUST be re-exported to match the black/natural geometry before use.",
  "background": "#F1EFEA",
  "frames": {
    "black": {
      "framed": { "file": "design/print-assets/frames_blanks/black_framed.png", "window": { "left": 0.2256, "top": 0.112, "width": 0.5488, "height": 0.7756 } },
      "mount": { "file": "design/print-assets/frames_blanks/black_mount.png", "window": { "left": 0.2648, "top": 0.1508, "width": 0.4703, "height": 0.698 } }
    },
    "natural": {
      "framed": { "file": "design/print-assets/frames_blanks/light_brown_framed.png", "window": { "left": 0.2256, "top": 0.112, "width": 0.5492, "height": 0.7756 } },
      "mount": { "file": "design/print-assets/frames_blanks/light_brown_mount.png", "window": { "left": 0.2648, "top": 0.1508, "width": 0.4707, "height": 0.698 } }
    },
    "brown": {
      "framed": { "file": "design/print-assets/frames_blanks/brown_framed.png", "window": { "left": 0.2256, "top": 0.112, "width": 0.5488, "height": 0.7756 } },
      "mount": { "file": "design/print-assets/frames_blanks/brown_mount.png", "window": { "left": 0.2648, "top": 0.1508, "width": 0.4703, "height": 0.698 } }
    }
  }
}
```

(Framed windows for black/natural are real measurements — window ratio ≈0.708 vs sheet 0.70 = 1.1% mismatch, inside the 2% tolerance. The activation task re-measures the three new/re-exported masters; the ratio guard catches any window that would distort the sheet.)

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
        master: fs.readFileSync(layer.file),
        sheet: sheets.get(kind)!,
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

### Task 6: Activation (deferred — blocked on remaining masters)

No code. Operator checklist. Already in hand (2026-07-19): `black_framed.png` and `light_brown_framed.png` (= natural), both 2500×2500 opaque blanks with measured windows. Still needed under `design/print-assets/frames_blanks/`:

1. **`brown_framed` re-export** — the current `brown_framed.jpg` (2000×2000) is from a different mockup source: window ratio 0.746 vs the 0.70 sheet, which the 2% guard rejects by design. Re-export with the same geometry as the black/natural blanks (ideally identical 2500×2500 canvas + window rect).
2. **Three mount blanks** (`black_mount`, `light_brown_mount`, `brown_mount`) — copies of the framed blanks with the passe-partout drawn in the window: fill the window white (`#FCFBF8`-ish), centred aperture at **85.7% of window width × 90% of window height** (physical Prodigi geometry, ratio 0.667 = CFPM sheet), aperture left empty (pipeline pastes the CFPM sheet there), bevel = 2–4 px light-grey inner edge + subtle top inner shadow (black 8–12%, 3–5 px blur).

Then:

- [ ] Copy `config/print-assets/frames.example.json` → `config/print-assets/frames.json`; re-measure each new master's `window` (fractions of its own canvas; the black/natural framed values are already measured). `composeMockup` throws on any window whose ratio drifts >2% from its sheet (0.70 framed / 0.667 mount) — iterate until clean.
- [ ] Run `npm run print-assets:mockups -- --product fap01 --dry-run`, review the plan, then run without `--dry-run` (needs `SUPABASE_*` + wrangler auth, same as `print-assets:gallery`).
- [ ] Visually inspect `public/uploads/fap-01-mock-*.webp` (6 states) — sheet not distorted, shadow/backdrop consistent across colours (the backdrop comes from the blanks themselves), aperture crop correct on mount states.
- [ ] Set `mockups: true` on `fap01` in `src/lib/prints.ts` (`PRINT_DESIGNS[0]`).
- [ ] Run `npx playwright test e2e/print-configurator.spec.ts` — the swap test now RUNS and must PASS; run `npm run test && npm run typecheck && npm run lint && npm run build`.
- [ ] Commit the WebPs + flag together: `git add public/uploads/fap-01-mock-*.webp src/lib/prints.ts config/print-assets/frames.json && git commit -m "feat(prints): enable live mockups for fap01"`.
- [ ] After fap02/fap03 fulfilment assets are published (separate ongoing effort), repeat for each (`fap02` produces only `framed-black`/`framed-natural`).

---

## Execution notes

- Task order is strict: 0 → 1 → 2 → (3, 4 in either order; 4 needs 3) → 5. Task 6 is deferred until the remaining masters are delivered (brown re-export + 3 mount blanks).
- Stacked per-domain PRs: **PR 1** = Task 0 (colour axis swap — its own reviewable domain, plus the post-merge operator steps in Task 0 Step 7), **PR 2** = Tasks 1–5 (mockup feature, flag off everywhere — user-invisible and safe to merge before any masters exist), **PR 3** = Task 6 activation.
- PR titles should be `feat:`-prefixed so release-please cuts versions.
