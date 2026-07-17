import { describe, it, expect } from 'vitest';
import {
  buildR2Key,
  distinctProfiles,
  buildManifest,
  validateManifest,
  refuseOverwrite,
  resolvePlacement,
  validateLayoutFractions,
  validatePlacementFit,
  validatePrepareConfig,
  validateVerticalFit,
  validateNoUpscale,
  type PrepareConfig,
  type PrintLayout,
} from './print-assets-prepare';

describe('buildR2Key', () => {
  it('builds a content-addressed R2 key', () => {
    const key = buildR2Key('fap01', '2026-07-11-r1', 3600, 4800, 'abc123', 'jpg');
    expect(key).toBe('prints/fap01/2026-07-11-r1/3600x4800-abc123.jpg');
  });

  it('supports png format', () => {
    const key = buildR2Key('fap01', '2026-07-11-r1', 3614, 4795, 'deadbeef', 'png');
    expect(key).toBe('prints/fap01/2026-07-11-r1/3614x4795-deadbeef.png');
  });
});

describe('distinctProfiles', () => {
  it('deduplicates variants sharing the same dimensions into one profile', () => {
    const variants = [
      { variantKey: '30x40:true:false:black', w: 3614, h: 4795 },
      { variantKey: '30x40:true:false:white', w: 3614, h: 4795 },
      { variantKey: '30x40:true:false:natural', w: 3600, h: 4800 },
    ];
    const profiles = distinctProfiles(variants);
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.profileKey).sort()).toEqual(['3600x4800', '3614x4795']);
  });

  it('maps every variant to its profile in assignments', () => {
    const variants = [
      { variantKey: '30x40:true:false:black', w: 3614, h: 4795 },
      { variantKey: '30x40:true:false:natural', w: 3600, h: 4800 },
    ];
    const profiles = distinctProfiles(variants);
    const byKey = new Map(profiles.map((p) => [p.profileKey, p]));
    expect(byKey.get('3614x4795')?.variantKeys).toEqual(['30x40:true:false:black']);
    expect(byKey.get('3600x4800')?.variantKeys).toEqual(['30x40:true:false:natural']);
  });
});

// ── Manifest ─────────────────────────────────────────────────────────────────

const LAYOUT_CONFIG: PrintLayout = {
  sideMargin: 0.1,
  topMargin: 0.1,
  bottomMargin: 0.1,
  gapAboveSignature: 0.05,
  signatureZoneHeight: 0.05,
};

const CONFIG: PrepareConfig = {
  product: 'fap01',
  artwork: 'design/print-assets/fap01/artwork-master.png',
  background: '#E8E0D7',
  format: 'jpg',
  layout: LAYOUT_CONFIG,
  signature: { svg: 'design/print-assets/fap01/signature.svg' },
};

describe('validatePrepareConfig', () => {
  it('accepts a complete composition config', () => {
    expect(validatePrepareConfig(CONFIG, 'fap01')).toEqual([]);
  });

  it('rejects malformed backgrounds and unsupported formats', () => {
    const invalid = { ...CONFIG, background: 'linen', format: 'webp' };
    const errors = validatePrepareConfig(invalid, 'fap01');
    expect(errors.some((error) => error.includes('#RRGGBB'))).toBe(true);
    expect(errors.some((error) => error.includes('jpg') && error.includes('png'))).toBe(true);
  });

  it('rejects missing required fields and malformed signature config', () => {
    const errors = validatePrepareConfig({ product: '', layout: {}, signature: {} }, 'fap01');
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('product'),
        expect.stringContaining('artwork'),
        expect.stringContaining('background'),
        expect.stringContaining('format'),
        expect.stringContaining('signature.svg'),
      ]),
    );
  });
});

function makeManifestInputs() {
  const profiles = distinctProfiles([
    { variantKey: '30x40:false:false:none', w: 1000, h: 1000 },
    { variantKey: '30x40:true:false:natural', w: 1000, h: 1000 },
    { variantKey: '50x70:true:false:black', w: 1400, h: 2000 },
  ]);
  return {
    product: 'fap01',
    revision: '2026-07-16-r1',
    sourceSha256: 'a'.repeat(64),
    sourceWidth: 1600,
    sourceHeight: 1600,
    signatureSha256: 'd'.repeat(64),
    layout: LAYOUT_CONFIG,
    background: '#E8E0D7',
    hasSignature: true,
    profiles,
    derivativeMeta: {
      '1000x1000': {
        sha256: 'b'.repeat(64),
        byteSize: 111,
        format: 'jpg' as const,
        placement: resolvePlacement(LAYOUT_CONFIG, { w: 1000, h: 1000 }, { w: 1600, h: 1600 }, true),
      },
      '1400x2000': {
        sha256: 'c'.repeat(64),
        byteSize: 222,
        format: 'jpg' as const,
        placement: resolvePlacement(LAYOUT_CONFIG, { w: 1400, h: 2000 }, { w: 1600, h: 1600 }, true),
      },
    },
  };
}

describe('buildManifest', () => {
  it('builds one derivative per distinct profile with its r2Key + placement', () => {
    const manifest = buildManifest(makeManifestInputs());
    expect(manifest.derivatives).toHaveLength(2);
    const byKey = new Map(manifest.derivatives.map((d) => [d.profileKey, d]));
    expect(byKey.get('1000x1000')).toMatchObject({
      width: 1000,
      height: 1000,
      format: 'jpg',
      contentType: 'image/jpeg',
      sha256: 'b'.repeat(64),
      byteSize: 111,
      r2Key: 'prints/fap01/2026-07-16-r1/1000x1000-' + 'b'.repeat(64) + '.jpg',
    });
    expect(byKey.get('1000x1000')?.artworkBoxPx).toEqual({
      x: 150,
      y: 100,
      width: 700,
      height: 700,
    });
    expect(byKey.get('1000x1000')?.signatureBoxPx).toMatchObject({ y: 850, height: 50 });
  });

  it('records the layout snapshot and both layer hashes', () => {
    const manifest = buildManifest(makeManifestInputs());
    expect(manifest.sourceSha256).toBe('a'.repeat(64));
    expect(manifest.signatureSha256).toBe('d'.repeat(64));
    expect(manifest.layout).toMatchObject({
      rendererVersion: expect.any(String),
      background: '#E8E0D7',
      artworkSha256: 'a'.repeat(64),
      signatureSha256: 'd'.repeat(64),
    });
  });

  it('maps every variant_key to its profile in assignments', () => {
    const manifest = buildManifest(makeManifestInputs());
    const assignmentByVariant = new Map(manifest.assignments.map((a) => [a.variantKey, a.profileKey]));
    expect(assignmentByVariant.get('30x40:false:false:none')).toBe('1000x1000');
    expect(assignmentByVariant.get('50x70:true:false:black')).toBe('1400x2000');
  });
});

describe('validateManifest', () => {
  it('reports no errors for a self-consistent manifest', () => {
    const manifest = buildManifest(makeManifestInputs());
    expect(validateManifest(manifest, CONFIG)).toEqual([]);
  });

  it('round-trips through JSON without losing structure', () => {
    const manifest = buildManifest(makeManifestInputs());
    const roundTripped = JSON.parse(JSON.stringify(manifest));
    expect(validateManifest(roundTripped, CONFIG)).toEqual([]);
    expect(roundTripped).toEqual(manifest);
  });

  it('fails when a derivative dimension does not match its profile key', () => {
    const manifest = buildManifest(makeManifestInputs());
    manifest.derivatives.find((d) => d.profileKey === '1000x1000')!.width = 9999;
    expect(validateManifest(manifest, CONFIG).some((e) => e.includes('1000x1000'))).toBe(true);
  });

  it('fails when a recorded artworkBoxPx does not match a recomputed placement', () => {
    const manifest = buildManifest(makeManifestInputs());
    manifest.derivatives.find((d) => d.profileKey === '1000x1000')!.artworkBoxPx.x = 0;
    expect(validateManifest(manifest, CONFIG).some((e) => /artworkBox|placement/i.test(e))).toBe(true);
  });

  it('fails when config or nested layer hashes drift from the manifest', () => {
    const manifest = buildManifest(makeManifestInputs());
    manifest.layout.background = '#ffffff';
    manifest.layout.signatureSha256 = 'e'.repeat(64);
    const errors = validateManifest(manifest, CONFIG);
    expect(errors.some((error) => error.includes('background'))).toBe(true);
    expect(errors.some((error) => error.includes('signature hashes'))).toBe(true);
  });

  it('fails when a recorded signatureBoxPx does not match a recomputed placement', () => {
    const manifest = buildManifest(makeManifestInputs());
    manifest.derivatives[0].signatureBoxPx!.x = 0;
    expect(validateManifest(manifest, CONFIG).some((error) => error.includes('signatureBoxPx'))).toBe(true);
  });

  it('fails on duplicate profiles and assignments that reference missing profiles', () => {
    const manifest = buildManifest(makeManifestInputs());
    manifest.derivatives.push({ ...manifest.derivatives[0] });
    manifest.assignments[0].profileKey = 'missing-profile';
    const errors = validateManifest(manifest, CONFIG);
    expect(errors.some((error) => error.includes('duplicate derivative profile'))).toBe(true);
    expect(errors.some((error) => error.includes('references missing profile'))).toBe(true);
  });
});

// ── Refusal to overwrite ─────────────────────────────────────────────────────

describe('refuseOverwrite', () => {
  it('does not throw when the output dir does not exist', () => {
    expect(() => refuseOverwrite('/tmp/does-not-exist', { exists: () => false })).not.toThrow();
  });

  it('throws when the output dir already exists and --force is not set', () => {
    expect(() => refuseOverwrite('/tmp/already-there', { exists: () => true })).toThrow(/already exists/i);
  });

  it('allows overwrite when force is set even if the dir exists', () => {
    expect(() => refuseOverwrite('/tmp/already-there', { exists: () => true, force: true })).not.toThrow();
  });
});

// ── Proportional layout (composition) ───────────────────────────────────────────

const LAYOUT: PrintLayout = {
  sideMargin: 0.1,
  topMargin: 0.1,
  bottomMargin: 0.1,
  gapAboveSignature: 0.05,
  signatureZoneHeight: 0.05,
};

describe('resolvePlacement', () => {
  it('places a same-aspect artwork centred with proportional margins', () => {
    // 1000x1000 canvas, 1:1 artwork fills the box.
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 800, h: 800 }, false);
    // sideMargin 10% of short side (1000) → mx = 100 → availableW = 800
    expect(p.artworkBox.x).toBe(100);
    expect(p.artworkBox.width).toBe(800);
    // artwork 800x800 contain-fills the 800-wide box exactly
    expect(p.artworkOut).toEqual({ width: 800, height: 800 });
    expect(p.artworkPos).toEqual({ x: 100, y: 100 });
    expect(p.scale).toBe(1);
  });

  it('contain-fits a different-aspect artwork without cropping', () => {
    // Wide artwork (1600x800, 2:1) in a square box → height-limited.
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 1600, h: 800 }, true);
    // artworkBox height = 1000 - 100(top) - 50(gap) - 50(sig) - 100(bottom) = 700
    expect(p.artworkBox.height).toBe(700);
    // scale limited by height: min(800/1600, 700/800) = min(0.5, 0.875) = 0.5
    expect(p.scale).toBe(0.5);
    expect(p.artworkOut).toEqual({ width: 800, height: 400 });
  });

  it('reserves and returns the signature zone when hasSignature is true', () => {
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 800, h: 800 }, true);
    // sigZoneTop = 1000 - 100(bottom) - 50(sigZone) = 850
    expect(p.signatureBox).toEqual({ x: 100, y: 850, width: 800, height: 50 });
  });

  it('collapses the signature zone and gap when hasSignature is false', () => {
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 800, h: 800 }, false);
    expect(p.signatureBox).toBeNull();
    // artworkBox height expands into the freed gap+sig space:
    // 1000 - 100(top) - 0 - 0 - 100(bottom) = 800
    expect(p.artworkBox.height).toBe(800);
  });

  it('honours optional artworkMaxWidth / artworkMaxHeight ceilings', () => {
    const layout: PrintLayout = { ...LAYOUT, artworkMaxWidth: 0.5, artworkMaxHeight: 0.4 };
    const p = resolvePlacement(layout, { w: 1000, h: 1000 }, { w: 800, h: 800 }, false);
    // availableW = 800, but artworkMaxWidth 0.5*1000 = 500 caps it
    expect(p.artworkBox.width).toBe(500);
    expect(p.artworkBox.x).toBe(250);
    // derived height 800, but artworkMaxHeight 0.4*1000 = 400 caps it
    expect(p.artworkBox.height).toBe(400);
  });

  it('keeps a width-limited artwork inside the centred capped box', () => {
    const layout: PrintLayout = { ...LAYOUT, artworkMaxWidth: 0.5 };
    const p = resolvePlacement(layout, { w: 1000, h: 1000 }, { w: 1000, h: 100 }, false);

    expect(p.artworkBox).toMatchObject({ x: 250, width: 500 });
    expect(p.artworkPos.x).toBeGreaterThanOrEqual(p.artworkBox.x);
    expect(p.artworkPos.x + p.artworkOut.width).toBeLessThanOrEqual(
      p.artworkBox.x + p.artworkBox.width,
    );
  });

  it('uses the short side for side margins so portrait vs landscape differ correctly', () => {
    // Landscape 1000x500 canvas, sideMargin 10% of short side (500) → mx = 50
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 500 }, { w: 800, h: 200 }, false);
    expect(p.artworkBox.x).toBe(50);
    expect(p.artworkBox.width).toBe(900); // 1000 - 2*50
  });
});

// ── Layout validation (runs before Sharp) ─────────────────────────────────────

const VALID: PrintLayout = {
  sideMargin: 0.1,
  topMargin: 0.1,
  bottomMargin: 0.1,
  gapAboveSignature: 0.05,
  signatureZoneHeight: 0.05,
};

describe('validateLayoutFractions', () => {
  it('reports no errors for fractions in [0, 1]', () => {
    expect(validateLayoutFractions(VALID)).toEqual([]);
  });

  it('rejects a fraction above 1', () => {
    const errors = validateLayoutFractions({ ...VALID, topMargin: 1.5 });
    expect(errors.some((e) => e.includes('topMargin'))).toBe(true);
  });

  it('rejects a negative fraction', () => {
    const errors = validateLayoutFractions({ ...VALID, sideMargin: -0.1 });
    expect(errors.some((e) => e.includes('sideMargin'))).toBe(true);
  });
});

describe('validateVerticalFit', () => {
  it('reports no errors when margins + gap + signature fit the canvas height', () => {
    expect(validateVerticalFit(VALID, { w: 1000, h: 1000 }, true)).toEqual([]);
  });

  it('fails when the vertical stack overflows the canvas', () => {
    // 10+10+5+5+10 = 40% — fine on 1000, but force an impossible stack:
    const layout: PrintLayout = { ...VALID, topMargin: 0.6, bottomMargin: 0.6 };
    const errors = validateVerticalFit(layout, { w: 1000, h: 1000 }, false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('collapses gap + signature when hasSignature is false', () => {
    // Would overflow only if gap+signature counted — they must not when false.
    const layout: PrintLayout = { ...VALID, gapAboveSignature: 0.9, signatureZoneHeight: 0.9 };
    expect(validateVerticalFit(layout, { w: 1000, h: 1000 }, false)).toEqual([]);
  });
});

describe('validatePlacementFit', () => {
  it('rejects layouts that leave zero or negative horizontal artwork space', () => {
    const invalid: PrintLayout = { ...VALID, sideMargin: 0.5 };
    expect(validatePlacementFit(invalid, { w: 1000, h: 1000 }, false)).toEqual([
      expect.stringContaining('no horizontal room'),
    ]);
  });

  it('rejects a configured signature with a zero-height zone', () => {
    const invalid: PrintLayout = { ...VALID, signatureZoneHeight: 0 };
    expect(validatePlacementFit(invalid, { w: 1000, h: 1000 }, true)).toEqual([
      expect.stringContaining('no room for the signature'),
    ]);
  });
});

describe('validateNoUpscale', () => {
  it('accepts an artwork at least as large as its box in the limiting dimension', () => {
    // box ~700 tall, artwork 800 tall → scale < 1
    expect(validateNoUpscale(VALID, { w: 1000, h: 1000 }, { w: 800, h: 800 }, true)).toEqual([]);
  });

  it('rejects an artwork that would be upscaled', () => {
    const errors = validateNoUpscale(VALID, { w: 1000, h: 1000 }, { w: 50, h: 50 }, true);
    expect(errors.some((e) => /upscale|enlarge/i.test(e))).toBe(true);
  });
});
