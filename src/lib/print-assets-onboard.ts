/**
 * Pure helpers for batch-onboarding new fine-art-print designs (operator
 * script: `scripts/print-assets-onboard.ts`). Turns one manifest row into
 * everything a design needs to enter the existing per-design pipeline
 * unchanged: a `config/print-assets/{id}.json` (the `PrepareConfig` shape from
 * print-assets-prepare.ts) and a `PrintDesign` registry entry (prints.ts).
 *
 * Every fap0N design shares one layout/background/format (confirmed identical
 * across fap01–fap03) — onboarding treats those as constants so a manifest row
 * only names what actually varies per design.
 */
import { z } from 'zod';
import { assetPxFor, PRODIGI_SKU_MAP, PRINT_FRAME_COLOURS, PRINT_SIZES } from './print-cart';
import { PRINT_RATIOS, type FullBleedPrepareConfig, type PosterPrepareConfig, type PrepareConfig, type PrintRatio, type VariantDimension } from './print-assets-prepare';
import type { PrintDesign, PrintFrameColour, PrintSize } from './types';

// ── Shared constants (identical across fap01/fap02/fap03 today) ────────────

export const ONBOARD_BACKGROUND = '#E6E0D3';
export const ONBOARD_FORMAT = 'jpg' as const;
export const ONBOARD_LAYOUT: PosterPrepareConfig['layout'] = {
  sideMargin: 0.035,
  topMargin: 0.025,
  bottomMargin: 0.058,
  gapAboveSignature: 0.03,
  signatureZoneHeight: 0.017,
  artworkMaxWidth: 0.93,
  artworkMaxHeight: 0.87,
};

/** Sizes ordered smallest → largest, so "largest offered size" is just the last match. */
const SIZE_ORDER: readonly PrintSize[] = ['30x40', '50x70', '70x100'];

/**
 * Every full-bleed design sells every variant (docs/plans/
 * full-bleed-print-assets-plan.md — no per-painting merchandising
 * restriction), so a fullBleed manifest row doesn't name axes at all; this
 * constant is the "full axes" `buildPrintDesignEntry`/`expectedVariantDimensions`
 * use for it.
 */
export const FULL_AXES: Pick<PosterOnboardingRow, 'sizes' | 'frameColours' | 'mountAvailable'> = {
  sizes: [...PRINT_SIZES],
  frameColours: [...PRINT_FRAME_COLOURS],
  mountAvailable: true,
};

const idSchema = z.string().regex(/^fap\d{3,}$/, 'id must look like "fap001"');

// ── Manifest schema ──────────────────────────────────────────────────────────

const posterOnboardingRowSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1),
    style: z.literal('poster'),
    incomingFile: z.string().min(1),
    sizes: z.array(z.enum(['30x40', '50x70', '70x100'])).min(1),
    frameColours: z.array(z.enum(['black', 'natural', 'brown'])),
    mountAvailable: z.boolean(),
    noteIndex: z.number().int().nonnegative(),
  })
  .strict();

const fullBleedOnboardingRowSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1),
    style: z.literal('fullBleed'),
    /**
     * The `NN` folder under `design/uploads/master-images-prints/{NN}/` this
     * design's four ratio masters live in. Defaults to the painting number
     * implied by `id` under the Phase 0 mapping (`NN -> fap(NN+4)`) —
     * override only when a design's id doesn't follow that convention.
     */
    masterFolder: z.string().regex(/^\d{2,}$/, 'masterFolder must look like "01"').optional(),
    noteIndex: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((row, ctx) => {
    // An omitted masterFolder must resolve via defaultMasterFolder(id) —
    // reject unresolvable ids (e.g. fap004, NN<=0) here rather than letting
    // checkFullBleedResolution/buildPrepareConfig throw later.
    if (row.masterFolder === undefined) {
      try {
        defaultMasterFolder(row.id);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['masterFolder'],
          message: `id "${row.id}" has no masterFolder and does not resolve one under the NN -> fap(NN+4) ` +
            `convention (${error instanceof Error ? error.message : error}) — set masterFolder explicitly.`,
        });
      }
    }
  });

export const onboardingRowSchema = z.discriminatedUnion('style', [
  posterOnboardingRowSchema,
  fullBleedOnboardingRowSchema,
]);

export const onboardingManifestSchema = z.array(onboardingRowSchema).min(1);

export type PosterOnboardingRow = z.infer<typeof posterOnboardingRowSchema>;
export type FullBleedOnboardingRow = z.infer<typeof fullBleedOnboardingRowSchema>;
export type OnboardingRow = z.infer<typeof onboardingRowSchema>;

/** `fap(NN+4)` inverse: derive the default `design/uploads/master-images-prints/{NN}/` folder from an id. */
export function defaultMasterFolder(id: string): string {
  const match = /^fap(\d+)$/.exec(id);
  if (!match) throw new Error(`id "${id}" does not match "fap<digits>"`);
  const n = parseInt(match[1], 10) - 4;
  if (n < 1) {
    throw new Error(`id "${id}" does not map to a positive painting number under the NN -> fap(NN+4) convention`);
  }
  return String(n).padStart(2, '0');
}

// ── Derivations ──────────────────────────────────────────────────────────────

export interface SourceProfile {
  profileKey: string;
  w: number;
  h: number;
}

/**
 * The unframed print-area profile for a design's largest offered size — the
 * same profile `gallery.hero.sourceProfile` and the mockups pipeline need.
 * Mirrors the existing fap01/fap03 (`70x100` → `8400x12000`) vs fap02
 * (`50x70` → `6000x8400`) split.
 */
export function deriveSourceProfile(sizes: readonly PrintSize[]): SourceProfile {
  const largest = SIZE_ORDER.filter((s) => sizes.includes(s)).at(-1);
  if (!largest) throw new Error(`No recognized size in ${JSON.stringify(sizes)}`);
  const entry = PRODIGI_SKU_MAP[`${largest}:false:false:none`];
  if (!entry) throw new Error(`No PRODIGI_SKU_MAP entry for unframed ${largest}`);
  const px = assetPxFor(entry);
  return { profileKey: `${px.w}x${px.h}`, w: px.w, h: px.h };
}

/** "fap001" → "fap-001" — the `image`/`uploadStem` convention every fap0N design uses. */
export function uploadStemFor(id: string): string {
  const match = /^([a-z]+)(\d+)$/i.exec(id);
  if (!match) throw new Error(`id "${id}" does not match "<prefix><digits>"`);
  return `${match[1]}-${match[2]}`;
}

/** Every ratio master path for a fullBleed row's resolved `masterFolder`. */
function fullBleedSources(folder: string): Record<PrintRatio, string> {
  return Object.fromEntries(
    PRINT_RATIOS.map((ratio) => [ratio, `design/uploads/master-images-prints/${folder}/${folder}__${ratio}.jpg`]),
  ) as Record<PrintRatio, string>;
}

/** The generated `config/print-assets/{id}.json` contents for one manifest row. */
export function buildPrepareConfig(row: OnboardingRow, sourceProfile: SourceProfile): PrepareConfig {
  if (row.style === 'fullBleed') {
    const folder = row.masterFolder ?? defaultMasterFolder(row.id);
    const config: FullBleedPrepareConfig = {
      product: row.id,
      mode: 'fullBleed',
      format: 'jpg',
      sources: fullBleedSources(folder),
      gallery: { hero: { sourceProfile: sourceProfile.profileKey, uploadStem: uploadStemFor(row.id) } },
    };
    return config;
  }
  const config: PosterPrepareConfig = {
    product: row.id,
    artwork: `design/print-assets/${row.id}/artwork-master.jpg`,
    background: ONBOARD_BACKGROUND,
    format: ONBOARD_FORMAT,
    layout: ONBOARD_LAYOUT,
    signature: { svg: `design/print-assets/${row.id}/signature.svg` },
    gallery: { hero: { sourceProfile: sourceProfile.profileKey, uploadStem: uploadStemFor(row.id) } },
  };
  return config;
}

/**
 * Every variant a design's manifest row will offer, resolved to ASSET pixels
 * (assetPxFor — the render we upload; black 30x40 framed shares the 3600×4800
 * render, prodigi/decisions.md #6) — the same universe `activeVariantDimensions`
 * (DB-backed, used by the real `print-assets:prepare`) would enumerate once the
 * design is live. Lets onboarding validate a master export against every
 * profile the design will actually need, not just its largest. Pass
 * `FULL_AXES` for a fullBleed row (which doesn't name axes itself).
 */
export function expectedVariantDimensions(
  row: Pick<PosterOnboardingRow, 'sizes' | 'frameColours' | 'mountAvailable'>,
): VariantDimension[] {
  const out: VariantDimension[] = [];
  const addIfMapped = (variantKey: string): void => {
    const entry = PRODIGI_SKU_MAP[variantKey];
    if (!entry) throw new Error(`No PRODIGI_SKU_MAP entry for variant key "${variantKey}"`);
    const px = assetPxFor(entry);
    out.push({ variantKey, w: px.w, h: px.h });
  };
  for (const size of row.sizes) {
    addIfMapped(`${size}:false:false:none`);
    for (const colour of row.frameColours) {
      addIfMapped(`${size}:true:false:${colour}`);
      if (row.mountAvailable) addIfMapped(`${size}:true:true:${colour}`);
    }
  }
  return out;
}

/** The generated `PrintDesign` registry entry for one manifest row — paste into `src/lib/prints.ts`. */
export function buildPrintDesignEntry(row: OnboardingRow): PrintDesign {
  const stem = uploadStemFor(row.id);
  const num = /^fap(\d+)$/.exec(row.id)![1];
  const axes = row.style === 'fullBleed' ? FULL_AXES : row;
  return {
    id: row.id,
    category: 'fine-art-prints',
    num,
    image: `/uploads/${stem}.webp`,
    noteIndex: row.noteIndex,
    sizes: [...axes.sizes] as PrintSize[],
    frameColours: [...axes.frameColours] as PrintFrameColour[],
    mountAvailable: axes.mountAvailable,
    published: false,
  };
}
