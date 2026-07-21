import { describe, it, expect } from 'vitest';
import {
  buildStagedRows,
  decideUploadAction,
  partitionStagedRows,
  compareRemoteToManifest,
  buildPublishAssignments,
  diffVariantCoverage,
  type StagedAssetRow,
} from './print-assets-publish';
import { buildR2Key, type ManifestDerivative, type PrepareManifest, type PublishManifest } from './print-assets-prepare';

// Module-scope regexes (avoid re-compiling inside each assertion).
const REFUSING_OVERWRITE_RE = /Refusing to overwrite/;
const SHA256_MISMATCH_RE = /sha256 mismatch/;
const BYTE_SIZE_MISMATCH_RE = /byte size mismatch/;
const DIMENSION_MISMATCH_RE = /dimension mismatch/;
const NO_READY_ROW_RE = /No ready print_fulfilment_assets row/;
const NO_DERIVATIVE_RE = /no\s+derivative for that profile/;

/** A minimal two-profile schema-v2 manifest: two derivatives, three variants (one shared). */
function manifest(overrides: Partial<PrepareManifest> = {}): PrepareManifest {
  const derivatives: ManifestDerivative[] = [
    {
      width: 3600,
      height: 4800,
      format: 'jpg',
      sha256: 'a'.repeat(64),
      byteSize: 1000,
      artworkBoxPx: { x: 0, y: 0, width: 3600, height: 4800 },
      signatureBoxPx: null,
    },
    {
      width: 4800,
      height: 7200,
      format: 'png',
      sha256: 'b'.repeat(64),
      byteSize: 2000,
      artworkBoxPx: { x: 0, y: 0, width: 4800, height: 7200 },
      signatureBoxPx: null,
    },
  ];
  return {
    schemaVersion: 2,
    product: 'fap01',
    revision: 'rev1',
    rendererVersion: '2.1.0',
    configSha256: 'c'.repeat(64),
    background: '#E8E0D7',
    layout: { sideMargin: 0.1, topMargin: 0.1, bottomMargin: 0.1, gapAboveSignature: 0.05, signatureZoneHeight: 0.05 },
    artwork: { path: 'design/print-assets/fap01/artwork.png', sha256: 'c'.repeat(64), width: 9000, height: 13000 },
    signature: null,
    derivatives,
    assignments: [
      { variantKey: 'small-unframed', profileKey: '3600x4800' },
      { variantKey: 'small-framed', profileKey: '3600x4800' },
      { variantKey: 'large-unframed', profileKey: '4800x7200' },
    ],
    ...overrides,
  };
}

/** The normalized publish projection (what loadPublishManifest returns). */
function publishManifest(overrides: Partial<PublishManifest> = {}): PublishManifest {
  return {
    product: 'fap01',
    revision: 'rev1',
    derivatives: [
      { width: 3600, height: 4800, format: 'jpg', sha256: 'a'.repeat(64) },
      { width: 4800, height: 7200, format: 'png', sha256: 'b'.repeat(64) },
    ],
    assignments: [
      { variantKey: 'small-unframed', profileKey: '3600x4800' },
      { variantKey: 'small-framed', profileKey: '3600x4800' },
      { variantKey: 'large-unframed', profileKey: '4800x7200' },
    ],
    ...overrides,
  };
}

const R2_SMALL = buildR2Key('fap01', 'rev1', 3600, 4800, 'a'.repeat(64), 'jpg');
const R2_LARGE = buildR2Key('fap01', 'rev1', 4800, 7200, 'b'.repeat(64), 'png');

describe('buildStagedRows', () => {
  it('projects one staged row per derivative, deriving key/profile/content-type', () => {
    const rows = buildStagedRows(manifest());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual<StagedAssetRow>({
      product_id: 'fap01',
      revision: 'rev1',
      profile_key: '3600x4800',
      r2_key: R2_SMALL,
      sha256: 'a'.repeat(64),
      content_type: 'image/jpeg',
      width_px: 3600,
      height_px: 4800,
      byte_size: 1000,
      status: 'staged',
    });
    expect(rows[1].content_type).toBe('image/png');
    expect(rows[1].r2_key).toBe(R2_LARGE);
    expect(rows.every((r) => r.status === 'staged')).toBe(true);
  });
});

describe('decideUploadAction', () => {
  const derivative = { sha256: 'a'.repeat(64), r2Key: R2_SMALL };

  it('uploads when nothing exists at the key', () => {
    expect(decideUploadAction(derivative, null)).toBe('put');
  });

  it('skips when the remote object is byte-identical', () => {
    expect(decideUploadAction(derivative, { sha256: 'a'.repeat(64) })).toBe('skip');
  });

  it('aborts when a different object already occupies the immutable key', () => {
    expect(() => decideUploadAction(derivative, { sha256: 'f'.repeat(64) })).toThrow(REFUSING_OVERWRITE_RE);
  });
});

describe('partitionStagedRows', () => {
  const rows = buildStagedRows(manifest());

  it('inserts every row when the DB has none', () => {
    const p = partitionStagedRows(rows, new Map());
    expect(p.toInsert).toHaveLength(2);
    expect(p.alreadyStaged).toEqual([]);
    expect(p.conflicts).toEqual([]);
  });

  it('skips rows already staged with matching bytes (idempotent re-run)', () => {
    const existing = new Map([[rows[0].r2_key, { sha256: rows[0].sha256 }]]);
    const p = partitionStagedRows(rows, existing);
    expect(p.toInsert).toHaveLength(1);
    expect(p.toInsert[0].r2_key).toBe(rows[1].r2_key);
    expect(p.alreadyStaged).toEqual([rows[0].r2_key]);
    expect(p.conflicts).toEqual([]);
  });

  it('flags a same-key/different-hash row as a conflict', () => {
    const existing = new Map([[rows[0].r2_key, { sha256: 'f'.repeat(64) }]]);
    const p = partitionStagedRows(rows, existing);
    expect(p.conflicts).toEqual([rows[0].r2_key]);
    expect(p.toInsert).toHaveLength(1);
  });
});

describe('compareRemoteToManifest', () => {
  const [derivative] = manifest().derivatives;

  it('returns no errors when the remote object matches the manifest', () => {
    const errors = compareRemoteToManifest(derivative, {
      sha256: derivative.sha256,
      byteSize: derivative.byteSize,
      width: derivative.width,
      height: derivative.height,
    });
    expect(errors).toEqual([]);
  });

  it('reports sha256, byte-size and dimension mismatches distinctly', () => {
    const errors = compareRemoteToManifest(derivative, { sha256: 'f'.repeat(64), byteSize: 999, width: 100, height: 200 });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(SHA256_MISMATCH_RE);
    expect(errors[1]).toMatch(BYTE_SIZE_MISMATCH_RE);
    expect(errors[2]).toMatch(DIMENSION_MISMATCH_RE);
  });
});

describe('buildPublishAssignments', () => {
  const assetIdByR2Key = new Map([
    [R2_SMALL, '11111111-1111-1111-1111-111111111111'],
    [R2_LARGE, '22222222-2222-2222-2222-222222222222'],
  ]);

  it('maps every variant to its profile derivative asset id', () => {
    const assignments = buildPublishAssignments(publishManifest(), assetIdByR2Key);
    expect(assignments).toEqual([
      { variant_key: 'small-unframed', asset_id: '11111111-1111-1111-1111-111111111111' },
      { variant_key: 'small-framed', asset_id: '11111111-1111-1111-1111-111111111111' },
      { variant_key: 'large-unframed', asset_id: '22222222-2222-2222-2222-222222222222' },
    ]);
  });

  it('fails closed when a profile derivative has no ready DB row', () => {
    const partial = new Map([[R2_SMALL, '11111111-1111-1111-1111-111111111111']]);
    expect(() => buildPublishAssignments(publishManifest(), partial)).toThrow(NO_READY_ROW_RE);
  });

  it('fails closed when an assignment references a profile with no derivative', () => {
    const broken = publishManifest({ assignments: [{ variantKey: 'ghost', profileKey: '9999x9999' }] });
    expect(() => buildPublishAssignments(broken, assetIdByR2Key)).toThrow(NO_DERIVATIVE_RE);
  });
});

describe('diffVariantCoverage', () => {
  it('reports no drift when active variants match the manifest exactly', () => {
    expect(diffVariantCoverage(['a', 'b'], ['b', 'a'])).toEqual({ missing: [], extra: [] });
  });

  it('flags an active variant added since prepare as missing', () => {
    expect(diffVariantCoverage(['a', 'b', 'c'], ['a', 'b'])).toEqual({ missing: ['c'], extra: [] });
  });

  it('flags a manifest variant no longer active as extra', () => {
    expect(diffVariantCoverage(['a'], ['a', 'b'])).toEqual({ missing: [], extra: ['b'] });
  });
});
