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
import { assetPxFor, PRODIGI_SKU_MAP } from './print-cart';
import type { PrepareConfig, VariantDimension } from './print-assets-prepare';
import type { PrintDesign, PrintFrameColour, PrintSize } from './types';

// ── Shared constants (identical across fap01/fap02/fap03 today) ────────────

export const ONBOARD_BACKGROUND = '#E6E0D3';
export const ONBOARD_FORMAT = 'jpg' as const;
export const ONBOARD_LAYOUT: PrepareConfig['layout'] = {
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

// ── Manifest schema ──────────────────────────────────────────────────────────

export const onboardingRowSchema = z
  .object({
    id: z.string().regex(/^fap\d{3,}$/, 'id must look like "fap001"'),
    title: z.string().min(1),
    incomingFile: z.string().min(1),
    sizes: z.array(z.enum(['30x40', '50x70', '70x100'])).min(1),
    frameColours: z.array(z.enum(['black', 'natural', 'brown'])),
    mountAvailable: z.boolean(),
    noteIndex: z.number().int().nonnegative(),
  })
  .strict();

export const onboardingManifestSchema = z.array(onboardingRowSchema).min(1);

export type OnboardingRow = z.infer<typeof onboardingRowSchema>;

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

/** The generated `config/print-assets/{id}.json` contents for one manifest row. */
export function buildPrepareConfig(row: OnboardingRow, sourceProfile: SourceProfile): PrepareConfig {
  return {
    product: row.id,
    artwork: `design/print-assets/${row.id}/artwork-master.jpg`,
    background: ONBOARD_BACKGROUND,
    format: ONBOARD_FORMAT,
    layout: ONBOARD_LAYOUT,
    signature: { svg: `design/print-assets/${row.id}/signature.svg` },
    gallery: { hero: { sourceProfile: sourceProfile.profileKey, uploadStem: uploadStemFor(row.id) } },
  };
}

/**
 * Every variant a design's manifest row will offer, resolved to ASSET pixels
 * (assetPxFor — the render we upload; black 30x40 framed shares the 3600×4800
 * render, prodigi/decisions.md #6) — the same universe `activeVariantDimensions`
 * (DB-backed, used by the real `print-assets:prepare`) would enumerate once the
 * design is live. Lets onboarding validate a Lightroom export against every
 * profile the design will actually need, not just its largest.
 */
export function expectedVariantDimensions(
  row: Pick<OnboardingRow, 'sizes' | 'frameColours' | 'mountAvailable'>,
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
  return {
    id: row.id,
    category: 'fine-art-prints',
    num,
    image: `/uploads/${stem}.webp`,
    noteIndex: row.noteIndex,
    sizes: [...row.sizes] as PrintSize[],
    frameColours: [...row.frameColours] as PrintFrameColour[],
    mountAvailable: row.mountAvailable,
    published: false,
  };
}
