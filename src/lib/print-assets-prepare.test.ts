import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  buildR2Key,
  buildManifest,
  contentTypeForFormat,
  derivativeR2Key,
  distinctProfiles,
  parsePrepareManifest,
  parsePublishManifest,
  profileKeyFromPx,
  resolvePlacement,
  validateLayoutFractions,
  validateNoUpscale,
  validatePlacement,
  validatePrepareConfig,
  COMPOSE_RENDERER_VERSION,
  type BuildManifestInput,
  type ManifestDerivative,
  type Placement,
  type PrepareConfig,
  type PrepareManifest,
  type PrintLayout,
} from './print-assets-prepare';

const FIXTURES = path.join(__dirname, '..', '..', 'test-fixtures', 'print-assets');

// ── Self-consistent v2 + legacy factories ─────────────────────────────────────

const V2_LAYOUT: PrintLayout = {
  sideMargin: 0.1,
  topMargin: 0.1,
  bottomMargin: 0.1,
  gapAboveSignature: 0.05,
  signatureZoneHeight: 0.05,
};
const V2_ARTWORK = { width: 8000, height: 8000 };

/** A derivative whose recorded boxes match resolvePlacement — passes semantic validation. */
function v2Derivative(width: number, height: number, sha: string): ManifestDerivative {
  const p = resolvePlacement(V2_LAYOUT, { w: width, h: height }, { w: V2_ARTWORK.width, h: V2_ARTWORK.height }, true);
  return {
    width,
    height,
    format: 'jpg',
    sha256: sha,
    byteSize: 1000,
    artworkBoxPx: { x: p.artworkPos.x, y: p.artworkPos.y, width: p.artworkOut.width, height: p.artworkOut.height },
    signatureBoxPx: p.signatureBox,
  };
}

function makeV2(overrides: Partial<PrepareManifest> = {}): PrepareManifest {
  return {
    schemaVersion: 2,
    product: 'fap01',
    revision: 'r2',
    rendererVersion: COMPOSE_RENDERER_VERSION,
    configSha256: 'c'.repeat(64),
    background: '#E8E0D7',
    layout: V2_LAYOUT,
    artwork: {
      path: 'design/print-assets/fap01/artwork.png',
      sha256: 'd'.repeat(64),
      width: V2_ARTWORK.width,
      height: V2_ARTWORK.height,
    },
    signature: { path: 'design/print-assets/fap01/signature.svg', sha256: 'e'.repeat(64) },
    derivatives: [v2Derivative(3600, 4800, 'a'.repeat(64)), v2Derivative(4800, 7200, 'b'.repeat(64))],
    assignments: [
      { variantKey: 'small', profileKey: '3600x4800' },
      { variantKey: 'large', profileKey: '4800x7200' },
    ],
    ...overrides,
  };
}

/** Deep-clone a valid v2 manifest and mutate it (as `unknown`, so structural breakage is allowed). */
function mutateV2(mutate: (m: PrepareManifest) => void): unknown {
  const clone = structuredClone(makeV2());
  mutate(clone);
  return clone;
}

/** A minimal, valid legacy manifest (the pre-schemaVersion 2026-07-12-r1 shape). */
function makeLegacy(overrides: Record<string, unknown> = {}): unknown {
  return {
    product: 'fap01',
    revision: '2026-07-12-r1',
    sourceSha256: 'c'.repeat(64),
    sourceWidth: 8400,
    sourceHeight: 12000,
    derivatives: [
      {
        profileKey: '3600x4800',
        width: 3600,
        height: 4800,
        format: 'jpg',
        contentType: 'image/jpeg',
        sha256: 'a'.repeat(64),
        byteSize: 1000,
        r2Key: `prints/fap01/2026-07-12-r1/3600x4800-${'a'.repeat(64)}.jpg`,
      },
      {
        profileKey: '4800x7200',
        width: 4800,
        height: 7200,
        format: 'jpg',
        contentType: 'image/jpeg',
        sha256: 'b'.repeat(64),
        byteSize: 2000,
        r2Key: `prints/fap01/2026-07-12-r1/4800x7200-${'b'.repeat(64)}.jpg`,
      },
    ],
    assignments: [
      { variantKey: 'small', profileKey: '3600x4800' },
      { variantKey: 'large', profileKey: '4800x7200' },
    ],
    ...overrides,
  };
}

// ── Pinned contracts (brief Step 1) ───────────────────────────────────────────

describe('pinned schema/derivation contracts', () => {
  it('parses a v2 manifest and reports schemaVersion 2', () => {
    expect(parsePrepareManifest(makeV2()).schemaVersion).toBe(2);
  });

  it('rejects a legacy manifest as not schema v2', () => {
    expect(() => parsePrepareManifest(makeLegacy())).toThrow(/schemaVersion.*2/i);
  });

  it('projects a legacy manifest for publish', () => {
    expect(parsePublishManifest(makeLegacy())).toMatchObject({ product: 'fap01', revision: '2026-07-12-r1' });
  });

  it('projects a v2 manifest for publish', () => {
    expect(parsePublishManifest(makeV2())).toMatchObject({ product: 'fap01', revision: 'r2' });
  });

  it('derives profile keys, MIME types, and R2 keys from canonical fields', () => {
    expect(profileKeyFromPx(3600, 4800)).toBe('3600x4800');
    expect(contentTypeForFormat('jpg')).toBe('image/jpeg');
    expect(contentTypeForFormat('png')).toBe('image/png');
    const validV2 = makeV2();
    expect(derivativeR2Key(validV2, validV2.derivatives[0])).toBe(
      `prints/fap01/r2/3600x4800-${'a'.repeat(64)}.jpg`,
    );
  });
});

// ── parsePrepareManifest — structural + semantic rejection table ───────────────

describe('parsePrepareManifest', () => {
  it('returns the validated manifest unchanged for a self-consistent input', () => {
    const manifest = makeV2();
    expect(parsePrepareManifest(manifest)).toEqual(manifest);
  });

  it('round-trips through JSON', () => {
    const manifest = makeV2();
    expect(parsePrepareManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a number scalar', 42],
    ['a string scalar', 'not-a-manifest'],
    ['an array', []],
    ['a missing schemaVersion', mutateV2((m) => delete (m as Record<string, unknown>).schemaVersion)],
    ['a wrong schemaVersion', mutateV2((m) => ((m as Record<string, unknown>).schemaVersion = 1))],
    ['an unknown top-level key', mutateV2((m) => ((m as Record<string, unknown>).surprise = true))],
    ['a missing derivatives array', mutateV2((m) => delete (m as Record<string, unknown>).derivatives)],
    ['an empty derivatives array', mutateV2((m) => (m.derivatives = []))],
    ['an empty assignments array', mutateV2((m) => (m.assignments = []))],
    ['a null derivative entry', mutateV2((m) => ((m.derivatives as unknown[])[0] = null))],
    ['a null assignment entry', mutateV2((m) => ((m.assignments as unknown[])[0] = null))],
    ['an invalid sha256', mutateV2((m) => (m.derivatives[0].sha256 = 'nothex'))],
    ['a zero width', mutateV2((m) => (m.derivatives[0].width = 0))],
    ['a negative height', mutateV2((m) => (m.derivatives[0].height = -1))],
    ['a zero byte size', mutateV2((m) => (m.derivatives[0].byteSize = 0))],
    ['an invalid format', mutateV2((m) => ((m.derivatives[0] as Record<string, unknown>).format = 'webp'))],
    ['a negative box coordinate', mutateV2((m) => (m.derivatives[0].artworkBoxPx.x = -1))],
    ['a zero-width box', mutateV2((m) => (m.derivatives[0].artworkBoxPx.width = 0))],
    ['an unsafe artwork path', mutateV2((m) => (m.artwork.path = '/etc/passwd'))],
    ['a traversing artwork path', mutateV2((m) => (m.artwork.path = 'design/../../secret'))],
    ['a non-hex background', mutateV2((m) => (m.background = 'linen'))],
    ['a bad renderer version', mutateV2((m) => (m.rendererVersion = 'two-point-one'))],
  ])('rejects %s', (_label, value) => {
    expect(() => parsePrepareManifest(value)).toThrow();
  });

  it('rejects duplicate derived profiles', () => {
    const dupe = mutateV2((m) => {
      m.derivatives[1] = { ...structuredClone(m.derivatives[0]), sha256: 'b'.repeat(64) };
    });
    expect(() => parsePrepareManifest(dupe)).toThrow(/duplicate.*profile/i);
  });

  it('rejects duplicate variant assignments', () => {
    const dupe = mutateV2((m) => {
      m.assignments[1] = { variantKey: 'small', profileKey: '4800x7200' };
    });
    expect(() => parsePrepareManifest(dupe)).toThrow(/duplicate assignment/i);
  });

  it('rejects an assignment referencing a non-existent profile', () => {
    const orphan = mutateV2((m) => {
      m.assignments[0] = { variantKey: 'small', profileKey: '9999x9999' };
    });
    expect(() => parsePrepareManifest(orphan)).toThrow(/missing profile/i);
  });

  it('rejects a derivative profile with no assignment (incomplete coverage)', () => {
    const uncovered = mutateV2((m) => {
      m.assignments = [{ variantKey: 'small', profileKey: '3600x4800' }];
    });
    expect(() => parsePrepareManifest(uncovered)).toThrow(/no variant assignment|coverage/i);
  });

  it('rejects a signature box present when the manifest has no signature', () => {
    const inconsistent = mutateV2((m) => {
      m.signature = null;
    });
    expect(() => parsePrepareManifest(inconsistent)).toThrow(/signature/i);
  });

  it('rejects a recorded artworkBoxPx that drifts from the recomputed placement', () => {
    const drift = mutateV2((m) => {
      m.derivatives[0].artworkBoxPx.x += 5;
    });
    expect(() => parsePrepareManifest(drift)).toThrow(/artworkBoxPx|placement|drift/i);
  });

  it('rejects a recorded signatureBoxPx that drifts from the recomputed placement', () => {
    const drift = mutateV2((m) => {
      m.derivatives[0].signatureBoxPx!.y += 7;
    });
    expect(() => parsePrepareManifest(drift)).toThrow(/signatureBoxPx|placement|drift/i);
  });
});

// ── parsePublishManifest — v2 + validated legacy projection ────────────────────

describe('parsePublishManifest', () => {
  it('projects a v2 manifest to the normalized publish shape', () => {
    const projected = parsePublishManifest(makeV2());
    expect(projected).toEqual({
      product: 'fap01',
      revision: 'r2',
      derivatives: [
        { width: 3600, height: 4800, format: 'jpg', sha256: 'a'.repeat(64) },
        { width: 4800, height: 7200, format: 'jpg', sha256: 'b'.repeat(64) },
      ],
      assignments: [
        { variantKey: 'small', profileKey: '3600x4800' },
        { variantKey: 'large', profileKey: '4800x7200' },
      ],
    });
  });

  it('projects a legacy manifest and drops derived fields', () => {
    const projected = parsePublishManifest(makeLegacy());
    expect(projected.derivatives[0]).toEqual({ width: 3600, height: 4800, format: 'jpg', sha256: 'a'.repeat(64) });
    expect(projected.derivatives[0]).not.toHaveProperty('r2Key');
    expect(projected.derivatives[0]).not.toHaveProperty('contentType');
  });

  it('rejects a legacy derivative whose stored profileKey disagrees with its dimensions', () => {
    expect(() =>
      parsePublishManifest(
        makeLegacy({
          derivatives: [
            {
              profileKey: '9999x9999',
              width: 3600,
              height: 4800,
              format: 'jpg',
              contentType: 'image/jpeg',
              sha256: 'a'.repeat(64),
              byteSize: 1000,
              r2Key: `prints/fap01/2026-07-12-r1/3600x4800-${'a'.repeat(64)}.jpg`,
            },
          ],
          assignments: [{ variantKey: 'small', profileKey: '9999x9999' }],
        }),
      ),
    ).toThrow(/profileKey/i);
  });

  it('rejects a legacy derivative whose stored contentType disagrees with its format', () => {
    expect(() =>
      parsePublishManifest(
        makeLegacy({
          derivatives: [
            {
              profileKey: '3600x4800',
              width: 3600,
              height: 4800,
              format: 'jpg',
              contentType: 'image/png',
              sha256: 'a'.repeat(64),
              byteSize: 1000,
              r2Key: `prints/fap01/2026-07-12-r1/3600x4800-${'a'.repeat(64)}.jpg`,
            },
          ],
          assignments: [{ variantKey: 'small', profileKey: '3600x4800' }],
        }),
      ),
    ).toThrow(/contentType/i);
  });

  it('rejects a legacy derivative whose stored r2Key was tampered', () => {
    expect(() =>
      parsePublishManifest(
        makeLegacy({
          derivatives: [
            {
              profileKey: '3600x4800',
              width: 3600,
              height: 4800,
              format: 'jpg',
              contentType: 'image/jpeg',
              sha256: 'a'.repeat(64),
              byteSize: 1000,
              r2Key: 'prints/fap01/2026-07-12-r1/tampered.jpg',
            },
          ],
          assignments: [{ variantKey: 'small', profileKey: '3600x4800' }],
        }),
      ),
    ).toThrow(/r2Key/i);
  });

  it('rejects an unknown schema version outright', () => {
    expect(() => parsePublishManifest({ ...(makeLegacy() as object), schemaVersion: 3 })).toThrow(/schemaVersion|schema version/i);
  });

  it('accepts the real 2026-07-12-r1 legacy fixture', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest-2026-07-12-r1.json'), 'utf8'));
    const projected = parsePublishManifest(fixture);
    expect(projected).toMatchObject({ product: 'fap01', revision: '2026-07-12-r1' });
    expect(projected.derivatives).toHaveLength(7);
    expect(projected.assignments).toHaveLength(21);
  });

  it('accepts the real 2026-07-19-r2 legacy fixture (with layout snapshot + boxes)', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest-2026-07-19-r2.json'), 'utf8'));
    const projected = parsePublishManifest(fixture);
    expect(projected).toMatchObject({ product: 'fap01', revision: '2026-07-19-r2' });
    expect(projected.derivatives).toHaveLength(7);
  });
});

// ── buildR2Key + distinctProfiles (unchanged behaviour) ────────────────────────

describe('buildR2Key', () => {
  it('builds a content-addressed R2 key', () => {
    expect(buildR2Key('fap01', '2026-07-11-r1', 3600, 4800, 'abc123', 'jpg')).toBe(
      'prints/fap01/2026-07-11-r1/3600x4800-abc123.jpg',
    );
  });

  it('supports png format', () => {
    expect(buildR2Key('fap01', '2026-07-11-r1', 3614, 4795, 'deadbeef', 'png')).toBe(
      'prints/fap01/2026-07-11-r1/3614x4795-deadbeef.png',
    );
  });
});

describe('distinctProfiles', () => {
  it('deduplicates variants sharing the same dimensions into one profile', () => {
    const profiles = distinctProfiles([
      { variantKey: '30x40:true:false:black', w: 3614, h: 4795 },
      { variantKey: '30x40:true:false:white', w: 3614, h: 4795 },
      { variantKey: '30x40:true:false:natural', w: 3600, h: 4800 },
    ]);
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.profileKey).sort()).toEqual(['3600x4800', '3614x4795']);
  });

  it('maps every variant to its profile in assignments', () => {
    const profiles = distinctProfiles([
      { variantKey: '30x40:true:false:black', w: 3614, h: 4795 },
      { variantKey: '30x40:true:false:natural', w: 3600, h: 4800 },
    ]);
    const byKey = new Map(profiles.map((p) => [p.profileKey, p]));
    expect(byKey.get('3614x4795')?.variantKeys).toEqual(['30x40:true:false:black']);
    expect(byKey.get('3600x4800')?.variantKeys).toEqual(['30x40:true:false:natural']);
  });
});

// ── validatePrepareConfig (unchanged behaviour) ────────────────────────────────

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
    const errors = validatePrepareConfig({ ...CONFIG, background: 'linen', format: 'webp' }, 'fap01');
    expect(errors.some((e) => e.includes('#RRGGBB'))).toBe(true);
    expect(errors.some((e) => e.includes('jpg') && e.includes('png'))).toBe(true);
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

// ── buildManifest → schema v2 ──────────────────────────────────────────────────

function makeBuildInputs(): BuildManifestInput {
  const profiles = distinctProfiles([
    { variantKey: '30x40:false:false:none', w: 1000, h: 1000 },
    { variantKey: '30x40:true:false:natural', w: 1000, h: 1000 },
    { variantKey: '50x70:true:false:black', w: 1400, h: 2000 },
  ]);
  return {
    product: 'fap01',
    revision: '2026-07-16-r1',
    configSha256: 'f'.repeat(64),
    background: '#E8E0D7',
    layout: LAYOUT_CONFIG,
    artworkManifestPath: 'design/print-assets/fap01/artwork-master.png',
    artworkSha256: 'a'.repeat(64),
    artworkWidth: 1600,
    artworkHeight: 1600,
    signatureManifestPath: 'design/print-assets/fap01/signature.svg',
    signatureSha256: 'd'.repeat(64),
    profiles,
    derivativeMeta: {
      '1000x1000': {
        sha256: 'b'.repeat(64),
        byteSize: 111,
        format: 'jpg',
        placement: resolvePlacement(LAYOUT_CONFIG, { w: 1000, h: 1000 }, { w: 1600, h: 1600 }, true),
      },
      '1400x2000': {
        sha256: 'c'.repeat(64),
        byteSize: 222,
        format: 'jpg',
        placement: resolvePlacement(LAYOUT_CONFIG, { w: 1400, h: 2000 }, { w: 1600, h: 1600 }, true),
      },
    },
  };
}

describe('buildManifest', () => {
  it('emits schema v2 with derivation-free derivatives', () => {
    const manifest = buildManifest(makeBuildInputs());
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.rendererVersion).toBe(COMPOSE_RENDERER_VERSION);
    expect(manifest.configSha256).toBe('f'.repeat(64));
    expect(manifest.artwork).toEqual({
      path: 'design/print-assets/fap01/artwork-master.png',
      sha256: 'a'.repeat(64),
      width: 1600,
      height: 1600,
    });
    const d = manifest.derivatives.find((x) => x.width === 1000)!;
    expect(d).not.toHaveProperty('profileKey');
    expect(d).not.toHaveProperty('contentType');
    expect(d).not.toHaveProperty('r2Key');
    expect(derivativeR2Key(manifest, d)).toBe(`prints/fap01/2026-07-16-r1/1000x1000-${'b'.repeat(64)}.jpg`);
    expect(d.artworkBoxPx).toEqual({ x: 150, y: 100, width: 700, height: 700 });
    expect(d.signatureBoxPx).toMatchObject({ y: 850, height: 50 });
  });

  it('stores a null signature when no signature layer is supplied', () => {
    const inputs = makeBuildInputs();
    inputs.signatureManifestPath = null;
    inputs.signatureSha256 = null;
    inputs.derivativeMeta = {
      '1000x1000': {
        sha256: 'b'.repeat(64),
        byteSize: 111,
        format: 'jpg',
        placement: resolvePlacement(LAYOUT_CONFIG, { w: 1000, h: 1000 }, { w: 1600, h: 1600 }, false),
      },
      '1400x2000': {
        sha256: 'c'.repeat(64),
        byteSize: 222,
        format: 'jpg',
        placement: resolvePlacement(LAYOUT_CONFIG, { w: 1400, h: 2000 }, { w: 1600, h: 1600 }, false),
      },
    };
    const manifest = buildManifest(inputs);
    expect(manifest.signature).toBeNull();
    expect(manifest.derivatives.every((d) => d.signatureBoxPx === null)).toBe(true);
  });

  it('produces a manifest that passes parsePrepareManifest self-validation', () => {
    const manifest = buildManifest(makeBuildInputs());
    expect(() => parsePrepareManifest(manifest)).not.toThrow();
  });
});

// ── resolvePlacement (unchanged behaviour) ─────────────────────────────────────

const LAYOUT: PrintLayout = {
  sideMargin: 0.1,
  topMargin: 0.1,
  bottomMargin: 0.1,
  gapAboveSignature: 0.05,
  signatureZoneHeight: 0.05,
};

describe('resolvePlacement', () => {
  it('places a same-aspect artwork centred with proportional margins', () => {
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 800, h: 800 }, false);
    expect(p.artworkBox.x).toBe(100);
    expect(p.artworkBox.width).toBe(800);
    expect(p.artworkOut).toEqual({ width: 800, height: 800 });
    expect(p.artworkPos).toEqual({ x: 100, y: 100 });
    expect(p.scale).toBe(1);
  });

  it('reserves and returns the signature zone when hasSignature is true', () => {
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 800, h: 800 }, true);
    expect(p.signatureBox).toEqual({ x: 100, y: 850, width: 800, height: 50 });
  });

  it('collapses the signature zone and gap when hasSignature is false', () => {
    const p = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 800, h: 800 }, false);
    expect(p.signatureBox).toBeNull();
    expect(p.artworkBox.height).toBe(800);
  });
});

// ── validateLayoutFractions (unchanged behaviour) ──────────────────────────────

describe('validateLayoutFractions', () => {
  it('reports no errors for fractions in [0, 1]', () => {
    expect(validateLayoutFractions(LAYOUT)).toEqual([]);
  });

  it('rejects a fraction above 1 or below 0', () => {
    expect(validateLayoutFractions({ ...LAYOUT, topMargin: 1.5 }).some((e) => e.includes('topMargin'))).toBe(true);
    expect(validateLayoutFractions({ ...LAYOUT, sideMargin: -0.1 }).some((e) => e.includes('sideMargin'))).toBe(true);
  });
});

// ── validatePlacement (replaces validateVerticalFit + validatePlacementFit) ─────

describe('validatePlacement', () => {
  const good = resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 800, h: 800 }, true);

  it('accepts an in-bounds placement on a valid canvas', () => {
    expect(validatePlacement(good, { w: 1000, h: 1000 })).toEqual([]);
  });

  it.each<[string, Placement, { w: number; h: number }]>([
    ['non-integer target dimensions', good, { w: 1000.5, h: 1000 }],
    ['a zero target dimension', good, { w: 0, h: 1000 }],
    ['a negative target dimension', good, { w: 1000, h: -1 }],
  ])('rejects %s', (_label, placement, target) => {
    expect(validatePlacement(placement, target).length).toBeGreaterThan(0);
  });

  it('rejects a non-positive artwork box', () => {
    const bad: Placement = { ...good, artworkBox: { x: 0, y: 0, width: 0, height: 100 } };
    expect(validatePlacement(bad, { w: 1000, h: 1000 }).length).toBeGreaterThan(0);
  });

  it('rejects an artwork box that exceeds the canvas', () => {
    const bad: Placement = { ...good, artworkBox: { x: 900, y: 0, width: 500, height: 100 } };
    expect(validatePlacement(bad, { w: 1000, h: 1000 }).some((e) => /canvas|bound|exceed/i.test(e))).toBe(true);
  });

  it('rejects a signature box that exceeds the canvas', () => {
    const bad: Placement = { ...good, signatureBox: { x: 0, y: 990, width: 100, height: 50 } };
    expect(validatePlacement(bad, { w: 1000, h: 1000 }).some((e) => /signature/i.test(e))).toBe(true);
  });
});

// ── validateNoUpscale (unchanged behaviour) ────────────────────────────────────

describe('validateNoUpscale', () => {
  it('accepts an artwork at least as large as its box in the limiting dimension', () => {
    expect(validateNoUpscale(LAYOUT, { w: 1000, h: 1000 }, { w: 800, h: 800 }, true)).toEqual([]);
  });

  it('rejects an artwork that would be upscaled', () => {
    const errors = validateNoUpscale(LAYOUT, { w: 1000, h: 1000 }, { w: 50, h: 50 }, true);
    expect(errors.some((e) => /upscale|enlarge/i.test(e))).toBe(true);
  });
});
