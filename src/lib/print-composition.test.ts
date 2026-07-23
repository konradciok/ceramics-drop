import { describe, it, expect } from 'vitest';
import {
  mmToPx,
  pxToMm,
  clampPx,
  containDimensions,
  composeLayout,
  buildAssetManifest,
  parseCompositionConfig,
  DEFAULT_LAYOUT,
  BACKGROUND_DEFAULT,
  RENDERER_VERSION,
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
    signature: 'config/print-composition/signature.svg',
    layout: DEFAULT_LAYOUT,
    opticalOffset: { x: 0, y: 0 },
    bleedMm: 0,
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

  it('emits integer pixel dimensions for every rect field', () => {
    for (const canvas of [
      { width: 3600, height: 4800 },
      { width: 8400, height: 12000 },
      { width: 1500, height: 2100 },
    ]) {
      const g = composeLayout(canvas, { aspect: 0.7 }, { aspect: 3 }, config);
      for (const r of [g.artwork, g.signature]) {
        for (const v of [r.left, r.top, r.width, r.height]) {
          expect(Number.isInteger(v)).toBe(true);
        }
      }
    }
  });
});

describe('pxToMm', () => {
  it('is the inverse of mmToPx (round-trips within a px)', () => {
    expect(pxToMm(300, 300)).toBe(25); // 25.4 mm → 25
    expect(pxToMm(mmToPx(100, 300), 300)).toBe(100);
  });
});

describe('buildAssetManifest', () => {
  const manifestConfig = {
    product: 'fap01',
    artwork: 'design/prints/fap01-artwork.tif',
    background: BACKGROUND_DEFAULT,
    signature: 'config/print-composition/signature.svg',
    layout: DEFAULT_LAYOUT,
    opticalOffset: { x: 0, y: 0 },
    bleedMm: 0,
  };
  const geo = composeLayout({ width: 3600, height: 4800 }, { aspect: 0.7 }, { aspect: 3 }, manifestConfig);

  it('maps the resolved boxes (left/top → x/y) and derives canvas mm + dpi', () => {
    const m = buildAssetManifest(geo, manifestConfig, 'abc123');
    expect(m.artworkBoxPx).toEqual({ x: geo.artwork.left, y: geo.artwork.top, width: geo.artwork.width, height: geo.artwork.height });
    expect(m.signatureBoxPx.x).toBe(geo.signature.left);
    expect(m.dpi).toBe(DEFAULT_LAYOUT.dpi);
    expect(m.canvasMm.width).toBe(pxToMm(3600, DEFAULT_LAYOUT.dpi));
    expect(m.bleedMm).toBe(0);
  });

  it('prefixes the source hash and stamps background + renderer version', () => {
    const m = buildAssetManifest(geo, manifestConfig, 'abc123');
    expect(m.sourceHash).toBe('sha256:abc123');
    expect(m.background).toBe('#ded9c3');
    expect(m.rendererVersion).toBe(RENDERER_VERSION);
  });

  it('flows bleedMm through from the config', () => {
    const m = buildAssetManifest(geo, { ...manifestConfig, bleedMm: 5 }, 'abc123');
    expect(m.bleedMm).toBe(5);
  });
});

describe('parseCompositionConfig', () => {
  const minimal = {
    product: 'fap01',
    artwork: 'design/prints/fap01-artwork.tif',
    signature: 'config/print-composition/signature.svg',
  };

  it('fills defaults for background, layout, bleed, and optical offset', () => {
    const cfg = parseCompositionConfig(minimal, 'fap01');
    expect(cfg.background).toBe('#ded9c3');
    expect(cfg.layout).toEqual(DEFAULT_LAYOUT);
    expect(cfg.opticalOffset).toEqual({ x: 0, y: 0 });
    expect(cfg.bleedMm).toBe(0);
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
});
