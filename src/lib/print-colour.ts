/* ============================================================
   Dominant colour families for a painting — pure pixel classifier.
   ------------------------------------------------------------
   Used by scripts/print-shop-facets.ts to seed the /sklep colour filter.
   The artwork sits on white paper with thin black ink lines, so both are
   discounted: paper is skipped, and "mono" only wins when dark/grey pixels
   dominate. Output is a SUGGESTION — a human reviews it (see
   config/print-shop.json `reviewed`). No I/O so it is unit-testable.
   ============================================================ */
import { SHOP_COLOURS, type ShopColour } from './print-shop';

export interface ColourAnalysis {
  /** Share (0..1) of the counted (non-paper) pixels in each family. */
  shares: Record<ShopColour, number>;
  /** Pixels that were not paper. */
  counted: number;
  /** Suggested families, strongest first. */
  colours: ShopColour[];
}

/** A family is suggested when it holds at least this share of the counted pixels. */
export const MIN_FAMILY_SHARE = 0.15;
/** "mono" (black/grey) needs a much larger share — ink lines appear in nearly every painting. */
export const MIN_MONO_SHARE = 0.4;
/** "earth" (beige/brown) also needs more: faint warm paper washes sit under most works and would make the filter meaningless. */
export const MIN_EARTH_SHARE = 0.3;
export const MAX_FAMILIES = 2;

/** RGB (0..255) → HSV with h in degrees [0,360), s and v in [0,1]. */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** Family of one pixel, or null when it is white paper. */
export function classifyPixel(r: number, g: number, b: number): ShopColour | null {
  const { h, s, v } = rgbToHsv(r, g, b);
  if (v > 0.85 && s < 0.1) return null; // paper (white / warm white)
  if (v < 0.25) return 'mono'; // ink, black
  if (s < 0.15) return v < 0.6 ? 'mono' : null; // dark grey wash = mono; light grey = paper shading, not colour
  if (h >= 260) return 'pink'; // violet → magenta → rose
  if (h < 12) {
    if (s >= 0.45 && v >= 0.55) return 'warm'; // red / terracotta
    return s >= 0.18 && v >= 0.6 ? 'pink' : 'earth'; // blush wash vs dull brown
  }
  if (h < 65) {
    if (s >= 0.45 && v >= 0.55) return 'warm'; // orange / ochre
    return h >= 40 && s >= 0.3 && v >= 0.7 ? 'warm' : 'earth'; // butter yellow vs beige/brown
  }
  if (h < 170) return 'green';
  return 'blue'; // cyan, teal, blue, indigo
}

/**
 * Classify a flat RGB(A) buffer. `channels` is 3 for RGB or 4 for RGBA;
 * fully transparent pixels are ignored.
 */
export function analyseColours(pixels: ArrayLike<number>, channels: 3 | 4 = 3): ColourAnalysis {
  const counts = Object.fromEntries(SHOP_COLOURS.map((c) => [c, 0])) as Record<ShopColour, number>;
  let counted = 0;
  for (let i = 0; i + channels <= pixels.length; i += channels) {
    if (channels === 4 && pixels[i + 3] === 0) continue;
    const family = classifyPixel(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (family) {
      counts[family]++;
      counted++;
    }
  }
  const shares = Object.fromEntries(
    SHOP_COLOURS.map((c) => [c, counted === 0 ? 0 : counts[c] / counted]),
  ) as Record<ShopColour, number>;

  const ranked = [...SHOP_COLOURS].sort((a, b) => shares[b] - shares[a]);
  const minShare = (c: ShopColour) => (c === 'mono' ? MIN_MONO_SHARE : c === 'earth' ? MIN_EARTH_SHARE : MIN_FAMILY_SHARE);
  const eligible = ranked.filter((c) => shares[c] >= minShare(c));
  // Always suggest at least the strongest family (a design must be findable).
  const colours = (eligible.length > 0 ? eligible : counted > 0 ? ranked.slice(0, 1) : []).slice(0, MAX_FAMILIES);
  return { shares, counted, colours };
}
