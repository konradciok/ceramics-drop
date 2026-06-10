import type { Locale } from '@/i18n/routing';

/** A string in every supported locale (pl default, en, es). */
export type Localized = Record<Locale, string>;

export interface LookMarker {
  /** Number shown on the photo and in the legend (1..N, sequential). */
  num: number;
  /** Product id from products.ts, e.g. 'k04'. Validated by looks.test.ts. */
  productId: string;
  /** Display name for the legend, per locale, e.g. { pl: 'Kubek', en: 'Mug', es: 'Taza' }. */
  label: Localized;
  /** Horizontal position on the photo, % from left edge (of the rendered 4:3 frame). */
  x: number;
  /** Vertical position on the photo, % from top edge (of the rendered 4:3 frame). */
  y: number;
}

export interface Look {
  /** URL-safe slug, e.g. 'slow-morning'. Unique across LOOKS. */
  id: string;
  /** Look title, per locale. Shown in the text column. */
  title: Localized;
  /** One atmospheric paragraph, per locale. Plain text. */
  editorial: Localized;
  /** Path in /public, e.g. '/uploads/look-01.webp'. Run npm run optimize-images first. */
  image: string;
  /** Alt text for the photo, per locale. */
  imageAlt: Localized;
  markers: LookMarker[];
}

/**
 * Editorial looks — the "Inspiracje" page data.
 *
 * Add entries here when Anna shoots a new interior look:
 *  1. Shoot / export the photo at a 4:3 aspect ratio (the page renders it in a
 *     fixed 4:3 frame with object-fit:cover; marker x/y are % of THAT frame, so
 *     a 4:3 source means nothing important gets cropped out).
 *  2. Drop the PNG into design/uploads/, run `npm run optimize-images`,
 *     reference the resulting /uploads/*.webp path in `image`.
 *  3. Tune marker x/y by loading the page locally.
 *  4. Provide pl/en/es strings for every localized field.
 */
export const LOOKS: Look[] = [];
