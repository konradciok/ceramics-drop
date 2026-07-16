import { describe, it, expect } from 'vitest';
import {
  buildR2Key,
  distinctProfiles,
  validateCropAspect,
  validateNoEnlargement,
  buildManifest,
  validateManifest,
  refuseOverwrite,
  validateProfileCoverage,
  resolvePlacement,
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

describe('validateCropAspect', () => {
  it('accepts a crop region whose aspect matches the target', () => {
    // 3000x4000 crop → target 3600x4800: both 3:4.
    expect(() =>
      validateCropAspect({ width: 3000, height: 4000 }, { w: 3600, h: 4800 }),
    ).not.toThrow();
  });

  it('rejects a crop region whose aspect does not match the target', () => {
    // 3000x4000 (3:4) vs target 3614x4795 (~0.7536, not exactly 3:4).
    expect(() =>
      validateCropAspect({ width: 3000, height: 4000 }, { w: 3614, h: 4795 }),
    ).toThrow(/aspect/i);
  });
});

describe('validateNoEnlargement', () => {
  it('accepts a source at least as large as the target', () => {
    expect(() => validateNoEnlargement({ width: 3600, height: 4800 }, { w: 3600, h: 4800 })).not.toThrow();
  });

  it('rejects a source smaller than the target width', () => {
    expect(() => validateNoEnlargement({ width: 3000, height: 4800 }, { w: 3600, h: 4800 })).toThrow(/enlarge/i);
  });

  it('rejects a source smaller than the target height', () => {
    expect(() => validateNoEnlargement({ width: 3600, height: 4000 }, { w: 3600, h: 4800 })).toThrow(/enlarge/i);
  });
});

// ── Manifest ─────────────────────────────────────────────────────────────────

const CONFIG: PrepareConfig = {
  product: 'fap01',
  profiles: {
    '3600x4800': { format: 'jpg', crop: { left: 0, top: 0, width: 3600, height: 4800 } },
    '3614x4795': { format: 'png', crop: { left: 0, top: 0, width: 3614, height: 4795 } },
  },
};

function makeManifestInputs() {
  const profiles = distinctProfiles([
    { variantKey: '30x40:false:false:none', w: 3600, h: 4800 },
    { variantKey: '30x40:true:false:natural', w: 3600, h: 4800 },
    { variantKey: '30x40:true:false:black', w: 3614, h: 4795 },
  ]);
  return {
    product: 'fap01',
    revision: '2026-07-11-r1',
    sourceSha256: 'a'.repeat(64),
    sourceWidth: 4000,
    sourceHeight: 5333,
    profiles,
    derivativeMeta: {
      '3600x4800': { sha256: 'b'.repeat(64), byteSize: 111, format: 'jpg' as const },
      '3614x4795': { sha256: 'c'.repeat(64), byteSize: 222, format: 'png' as const },
    },
  };
}

describe('buildManifest', () => {
  it('builds one derivative per distinct profile with its r2Key', () => {
    const manifest = buildManifest(makeManifestInputs());
    expect(manifest.derivatives).toHaveLength(2);
    const byKey = new Map(manifest.derivatives.map((d) => [d.profileKey, d]));
    expect(byKey.get('3600x4800')).toMatchObject({
      width: 3600,
      height: 4800,
      format: 'jpg',
      contentType: 'image/jpeg',
      sha256: 'b'.repeat(64),
      byteSize: 111,
      r2Key: 'prints/fap01/2026-07-11-r1/3600x4800-' + 'b'.repeat(64) + '.jpg',
    });
  });

  it('sets the MIME contentType from format for both jpg and png', () => {
    const manifest = buildManifest(makeManifestInputs());
    const byKey = new Map(manifest.derivatives.map((d) => [d.profileKey, d]));
    expect(byKey.get('3600x4800')?.contentType).toBe('image/jpeg');
    expect(byKey.get('3614x4795')?.contentType).toBe('image/png');
  });

  it('maps every variant_key to its profile in assignments', () => {
    const manifest = buildManifest(makeManifestInputs());
    const assignmentByVariant = new Map(manifest.assignments.map((a) => [a.variantKey, a.profileKey]));
    expect(assignmentByVariant.get('30x40:false:false:none')).toBe('3600x4800');
    expect(assignmentByVariant.get('30x40:true:false:natural')).toBe('3600x4800');
    expect(assignmentByVariant.get('30x40:true:false:black')).toBe('3614x4795');
  });

  it('carries source metadata through unchanged', () => {
    const manifest = buildManifest(makeManifestInputs());
    expect(manifest.product).toBe('fap01');
    expect(manifest.revision).toBe('2026-07-11-r1');
    expect(manifest.sourceSha256).toBe('a'.repeat(64));
    expect(manifest.sourceWidth).toBe(4000);
    expect(manifest.sourceHeight).toBe(5333);
  });
});

describe('validateManifest', () => {
  it('reports no errors for a manifest that covers every configured profile', () => {
    const manifest = buildManifest(makeManifestInputs());
    expect(validateManifest(manifest, CONFIG)).toEqual([]);
  });

  it('round-trips through JSON without losing structure', () => {
    const manifest = buildManifest(makeManifestInputs());
    const roundTripped = JSON.parse(JSON.stringify(manifest));
    expect(validateManifest(roundTripped, CONFIG)).toEqual([]);
    expect(roundTripped).toEqual(manifest);
  });

  it('fails when a required config profile has no derivative', () => {
    const manifest = buildManifest(makeManifestInputs());
    manifest.derivatives = manifest.derivatives.filter((d) => d.profileKey !== '3614x4795');
    const errors = validateManifest(manifest, CONFIG);
    expect(errors.some((e) => e.includes('3614x4795'))).toBe(true);
  });

  it('fails when a derivative dimension does not match its declared profile key', () => {
    const manifest = buildManifest(makeManifestInputs());
    const bad = manifest.derivatives.find((d) => d.profileKey === '3600x4800')!;
    bad.width = 9999;
    const errors = validateManifest(manifest, CONFIG);
    expect(errors.some((e) => e.includes('3600x4800'))).toBe(true);
  });

  it('fails when a derivative contentType does not match its format', () => {
    const manifest = buildManifest(makeManifestInputs());
    const bad = manifest.derivatives.find((d) => d.profileKey === '3600x4800')!;
    bad.contentType = 'image/png';
    const errors = validateManifest(manifest, CONFIG);
    expect(errors.some((e) => e.includes('contentType'))).toBe(true);
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

// ── Profile coverage (config ↔ active variants) ─────────────────────────────

describe('validateProfileCoverage', () => {
  it('reports no errors when config and active variants agree exactly', () => {
    const profiles = distinctProfiles([
      { variantKey: 'a', w: 3600, h: 4800 },
      { variantKey: 'b', w: 3614, h: 4795 },
    ]);
    const errors = validateProfileCoverage(['3600x4800', '3614x4795'], profiles);
    expect(errors).toEqual([]);
  });

  it('fails when an active profile has no config entry', () => {
    const profiles = distinctProfiles([{ variantKey: 'a', w: 3600, h: 4800 }]);
    const errors = validateProfileCoverage([], profiles);
    expect(errors.some((e) => e.includes('3600x4800'))).toBe(true);
  });

  it('fails when config declares a profile no active variant needs (stale entry)', () => {
    const profiles = distinctProfiles([{ variantKey: 'a', w: 3600, h: 4800 }]);
    const errors = validateProfileCoverage(['3600x4800', '9999x9999'], profiles);
    expect(errors.some((e) => e.includes('9999x9999') && e.includes('stale'))).toBe(true);
  });

  it('reports both directions of mismatch at once', () => {
    const profiles = distinctProfiles([{ variantKey: 'a', w: 3600, h: 4800 }]);
    const errors = validateProfileCoverage(['9999x9999'], profiles);
    expect(errors).toHaveLength(2);
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
    // derived height 800, but artworkMaxHeight 0.4*1000 = 400 caps it
    expect(p.artworkBox.height).toBe(400);
  });

  it('uses the short side for side margins so portrait vs landscape differ correctly', () => {
    // Landscape 1000x500 canvas, sideMargin 10% of short side (500) → mx = 50
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 500 }, { w: 800, h: 200 }, false);
    expect(p.artworkBox.x).toBe(50);
    expect(p.artworkBox.width).toBe(900); // 1000 - 2*50
  });
});
