import { describe, expect, it } from 'vitest';
import {
  designMockupStates,
  mockupHeroSrc,
  mockupSrc,
  mockupState,
  printListingImage,
  withRegistryMockups,
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

  it('throws when image path has no extension', () => {
    const noExt: PrintDesign = { ...flagged, image: '/uploads/no-extension' };
    expect(() => mockupSrc(noExt, 'framed-black')).toThrow('mockupSrc() requires a file extension');
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

describe('printListingImage', () => {
  // Listing tiles default to the framed-natural mockup (2026-08 unified
  // presentation); db-mode designs need the registry merge exactly like the
  // PDP hero, so failure modes degrade to the plain artwork, never a 404.
  it('returns the framed-natural mockup for flagged designs', () => {
    expect(printListingImage(design, flagged)).toBe('/uploads/fap-01-mock-framed-natural.webp');
    expect(printListingImage(flagged, flagged)).toBe('/uploads/fap-01-mock-framed-natural.webp');
  });

  it('falls back to the plain artwork without the mockups flag', () => {
    expect(printListingImage(design, design)).toBe('/uploads/fap-01.webp');
    expect(printListingImage(design, undefined)).toBe('/uploads/fap-01.webp');
  });

  it('falls back when the design offers no natural frame (asset would not exist)', () => {
    const noNatural: PrintDesign = { ...flagged, frameColours: ['black', 'brown'] };
    expect(printListingImage(noNatural, noNatural)).toBe('/uploads/fap-01.webp');
  });

  it('falls back when the db image drifts from the registry stem', () => {
    const drifted: PrintDesign = { ...design, image: '/uploads/fap-01-v2.webp' };
    expect(printListingImage(drifted, flagged)).toBe('/uploads/fap-01-v2.webp');
  });
});

describe('withRegistryMockups', () => {
  // The db-mode compensation PrintProductScreen relies on (and the reason the
  // catalog parity tests may compare modulo `mockups`).
  const dbDesign: PrintDesign = { ...design }; // mapper output never carries the flag
  const flaggedRegistry: PrintDesign = { ...design, mockups: true };

  it('merges the flag when the registry design is flagged and images match', () => {
    expect(withRegistryMockups(dbDesign, flaggedRegistry)).toEqual({ ...dbDesign, mockups: true });
  });

  it('does not mutate its input', () => {
    const input = { ...dbDesign };
    withRegistryMockups(input, flaggedRegistry);
    expect(input.mockups).toBeUndefined();
  });

  it('degrades to the static hero when the DB image drifts from the registry stem', () => {
    const drifted = { ...dbDesign, image: '/uploads/fap-01-v2.webp' };
    expect(withRegistryMockups(drifted, flaggedRegistry)).toBe(drifted);
  });

  it('is a no-op for unflagged registry designs and unknown ids', () => {
    expect(withRegistryMockups(dbDesign, { ...design })).toBe(dbDesign);
    expect(withRegistryMockups(dbDesign, undefined)).toBe(dbDesign);
  });
});
