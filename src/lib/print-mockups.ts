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
  if (dot === -1) throw new Error(`mockupSrc() requires a file extension in design image path: ${design.image}`);
  return `${design.image.slice(0, dot)}-mock-${state}${design.image.slice(dot)}`;
}

/** Hero src for the current selection, falling back to the base image. */
export function mockupHeroSrc(design: PrintDesign, sel: PrintVariantSelection): string {
  return mockupSrc(design, mockupState(sel)) ?? design.image;
}

/**
 * Merge the code registry's `mockups` flag into a DB-sourced design
 * (CATALOG_SOURCE=db). The flag is code-bundle truth, never DB truth: the
 * WebPs ship in the bundle and the catalog mapper doesn't carry the flag.
 * Guarded on image parity — mock filenames derive from the REGISTRY image
 * stem, so if the DB media row ever drifts from it, degrade to the static
 * hero (the designed dormant mode) instead of 404ing mockupSrc.
 */
export function withRegistryMockups(
  design: PrintDesign,
  registryDesign: PrintDesign | undefined,
): PrintDesign {
  return registryDesign?.mockups && registryDesign.image === design.image
    ? { ...design, mockups: true }
    : design;
}

/**
 * Default storefront presentation of a print (listing tiles, cards): the
 * framed-natural mockup, falling back to the plain artwork when the design
 * has no mockups, no 'natural' frame, or (db mode) a drifted image. Pass the
 * code-registry design as `registryDesign` like withRegistryMockups — under
 * CATALOG_SOURCE=db the mapped design never carries the `mockups` flag.
 */
export function printListingImage(
  design: PrintDesign,
  registryDesign: PrintDesign | undefined,
): string {
  const merged = withRegistryMockups(design, registryDesign);
  if (!merged.frameColours.includes('natural')) return merged.image;
  return mockupSrc(merged, 'framed-natural') ?? merged.image;
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
